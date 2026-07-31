import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  NAME,
  VERSION,
  formatBanner,
  parsePackageMeta,
  readPackageMeta,
} from '../lib/version.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── parsePackageMeta ────────────────────────────────────────────────────────

test('parsePackageMeta extracts exactly name and version', () => {
  const meta = parsePackageMeta('{"name":"gp-arb-bot","version":"1.2.3"}');
  assert.deepEqual(meta, { name: 'gp-arb-bot', version: '1.2.3' });
});

test('parsePackageMeta ignores every other package.json field', () => {
  const meta = parsePackageMeta(
    '{"name":"a","version":"0.0.1","type":"module","private":true,"scripts":{"test":"x"}}',
  );
  assert.deepEqual(meta, { name: 'a', version: '0.0.1' });
});

test('parsePackageMeta returns a frozen object', () => {
  const meta = parsePackageMeta('{"name":"a","version":"0.0.1"}');
  assert.equal(Object.isFrozen(meta), true);
  assert.throws(() => {
    'use strict';
    meta.name = 'mutated';
  }, TypeError);
  assert.equal(meta.name, 'a');
});

test('parsePackageMeta rejects malformed JSON with a message naming the cause', () => {
  assert.throws(
    () => parsePackageMeta('{not json'),
    /package\.json is not valid JSON/,
  );
});

test('parsePackageMeta rejects a non-string argument', () => {
  assert.throws(() => parsePackageMeta(null), /expects the raw package\.json text/);
  assert.throws(() => parsePackageMeta({ name: 'a' }), /expects the raw package\.json text/);
});

test('parsePackageMeta rejects JSON that is not an object', () => {
  for (const text of ['null', '5', '"a string"', '[]', 'true']) {
    assert.throws(
      () => parsePackageMeta(text),
      /package\.json must be a JSON object/,
      `expected ${text} to be rejected`,
    );
  }
});

test('parsePackageMeta requires a non-empty string name', () => {
  assert.throws(() => parsePackageMeta('{"version":"0.0.1"}'), /"name" must be a non-empty string/);
  assert.throws(
    () => parsePackageMeta('{"name":"","version":"0.0.1"}'),
    /"name" must be a non-empty string/,
  );
  assert.throws(
    () => parsePackageMeta('{"name":"   ","version":"0.0.1"}'),
    /"name" must be a non-empty string/,
  );
  assert.throws(
    () => parsePackageMeta('{"name":7,"version":"0.0.1"}'),
    /"name" must be a non-empty string/,
  );
});

test('parsePackageMeta requires a major.minor.patch version', () => {
  for (const bad of ['1.2', 'v1.2.3', '1.2.3-beta', '1.2.3.4', '', 'x.y.z', ' 1.2.3']) {
    assert.throws(
      () => parsePackageMeta(`{"name":"a","version":${JSON.stringify(bad)}}`),
      /"version" must look like major\.minor\.patch/,
      `expected version ${JSON.stringify(bad)} to be rejected`,
    );
  }
  assert.throws(() => parsePackageMeta('{"name":"a"}'), /"version" must look like major\.minor\.patch/);
  assert.throws(
    () => parsePackageMeta('{"name":"a","version":123}'),
    /"version" must look like major\.minor\.patch/,
  );
});

test('parsePackageMeta accepts multi-digit and zero version components', () => {
  assert.deepEqual(parsePackageMeta('{"name":"a","version":"0.0.0"}'), {
    name: 'a',
    version: '0.0.0',
  });
  assert.deepEqual(parsePackageMeta('{"name":"a","version":"10.20.30"}'), {
    name: 'a',
    version: '10.20.30',
  });
});

test('parsePackageMeta preserves a name with surrounding content but rejects blank-only', () => {
  assert.deepEqual(parsePackageMeta('{"name":" a ","version":"0.0.1"}'), {
    name: ' a ',
    version: '0.0.1',
  });
});

// ── formatBanner ────────────────────────────────────────────────────────────

test('formatBanner renders "<name> v<version>"', () => {
  assert.equal(formatBanner({ name: 'gp-arb-bot', version: '0.0.1' }), 'gp-arb-bot v0.0.1');
  assert.equal(formatBanner({ name: 'other', version: '12.0.4' }), 'other v12.0.4');
});

test('formatBanner rejects a meta object it cannot render', () => {
  assert.throws(() => formatBanner(null), /formatBanner expects \{ name, version \}/);
  assert.throws(() => formatBanner({ name: 'a' }), /formatBanner expects \{ name, version \}/);
  assert.throws(() => formatBanner({ version: '0.0.1' }), /formatBanner expects \{ name, version \}/);
  assert.throws(() => formatBanner({ name: '', version: '0.0.1' }), /formatBanner expects \{ name, version \}/);
  assert.throws(() => formatBanner({ name: 'a', version: 1 }), /formatBanner expects \{ name, version \}/);
});

// ── readPackageMeta ─────────────────────────────────────────────────────────

test('readPackageMeta reads this repo\'s real package.json by default', () => {
  const onDisk = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(readPackageMeta(), { name: onDisk.name, version: onDisk.version });
});

test('readPackageMeta reads an explicitly supplied path', () => {
  // Oracle read independently with readFileSync/JSON.parse — never by calling
  // readPackageMeta itself, which would let a wrong result agree with itself.
  const onDisk = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(readPackageMeta(join(REPO_ROOT, 'package.json')), {
    name: onDisk.name,
    version: onDisk.version,
  });
});

test('readPackageMeta names the unreadable path in its error', () => {
  const missing = join(REPO_ROOT, 'definitely-not-here', 'package.json');
  assert.throws(() => readPackageMeta(missing), (err) => {
    assert.match(err.message, /could not read package\.json/);
    assert.match(err.message, /definitely-not-here/);
    return true;
  });
});

// ── exported constants ──────────────────────────────────────────────────────

test('NAME and VERSION match the package.json on disk', () => {
  const onDisk = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(NAME, 'gp-arb-bot');
  assert.equal(NAME, onDisk.name);
  assert.equal(VERSION, onDisk.version);
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test('the repo declares zero runtime dependencies', () => {
  const onDisk = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(onDisk.dependencies, undefined);
});
