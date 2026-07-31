import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDriftDetector, missingKeys } from '../lib/contract.mjs';

// ── missingKeys: the absent/null distinction ────────────────────────────────

test('a key present with a null value is DATA, not drift', () => {
  // This is the whole point of the module. `best_ask: null` is the venue saying "nothing
  // is offered" -- a normal, frequent, correct answer. Treating it as drift would fire an
  // alert on every unquoted book, which is most of them, and the alert would be ignored
  // within a day.
  assert.deepEqual(missingKeys({ best_ask: null, best_bid: null }, ['best_ask', 'best_bid']), []);
});

test('an ABSENT key is drift', () => {
  // A renamed or dropped field reads as `undefined` at every use site, which flows on as
  // "no ask" -- indistinguishable from an empty book. The scanner keeps running, records
  // nothing, and looks healthy. That is the failure this detects.
  assert.deepEqual(missingKeys({ best_bid: 0.4 }, ['best_ask', 'best_bid']), ['best_ask']);
});

test('missingKeys reports every absent key, not just the first', () => {
  assert.deepEqual(missingKeys({ b: 1 }, ['a', 'b', 'c', 'd']), ['a', 'c', 'd']);
});

test('an inherited key does not count as present', () => {
  // `'toString' in payload` is true for every object alive. Using `in` here would declare
  // a contract satisfied by a field the venue never sent.
  assert.deepEqual(missingKeys({}, ['toString', 'constructor', 'hasOwnProperty']), [
    'toString',
    'constructor',
    'hasOwnProperty',
  ]);
});

test('a key inherited from a prototype chain is still absent', () => {
  const parent = { asks: [] };
  const child = Object.create(parent);
  child.bids = [];
  assert.deepEqual(missingKeys(child, ['asks', 'bids']), ['asks']);
});

test('a falsy value is present — 0, empty string and false are all real data', () => {
  assert.deepEqual(missingKeys({ size: 0, id: '', open: false }, ['size', 'id', 'open']), []);
});

test('a payload that is not an object is total drift, not a crash', () => {
  // A 502 HTML error page parsed as JSON, or a bare `null` body, must produce a drift
  // report rather than a TypeError that kills the scan loop.
  for (const bad of [null, undefined, 'a string', 42, true]) {
    assert.deepEqual(missingKeys(bad, ['a', 'b']), ['a', 'b'], String(bad));
  }
});

test('an array payload is checked by key like any other object', () => {
  assert.deepEqual(missingKeys([1, 2], ['0', '1']), []);
  assert.deepEqual(missingKeys([1], ['0', '1']), ['1']);
});

test('an empty required list is trivially satisfied', () => {
  assert.deepEqual(missingKeys({ a: 1 }, []), []);
});

test('missingKeys rejects a non-array contract rather than silently passing everything', () => {
  // A typo'd spec that quietly checks nothing is the worst outcome here: the detector
  // reports "no drift" forever and nobody learns it was never looking.
  for (const bad of [undefined, null, 'best_ask', { 0: 'a' }]) {
    assert.throws(() => missingKeys({}, bad), TypeError, String(bad));
  }
});

// ── the detector: report once, not once per message ─────────────────────────

const KEYS = ['asset_id', 'asks'];

test('drift is reported the first time it is seen', () => {
  const seen = [];
  const d = createDriftDetector({ required: KEYS, label: 'polymarket book', onDrift: (r) => seen.push(r) });

  assert.equal(d.check({ asset_id: 'x' }, 1000), false);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].missing, ['asks']);
  assert.equal(seen[0].label, 'polymarket book');
  assert.match(seen[0].message, /asks/);
});

test('the same drift is not re-reported on every subsequent message', () => {
  // A drifted field is drifted on every frame — thousands per minute. Reporting each one
  // is a self-inflicted denial of service on the alert channel.
  const seen = [];
  const d = createDriftDetector({ required: KEYS, label: 'book', onDrift: (r) => seen.push(r), repeatMs: 60_000 });

  for (let i = 0; i < 500; i += 1) d.check({ asset_id: 'x' }, 1000 + i);
  assert.equal(seen.length, 1);
});

test('persistent drift is re-reported once the repeat interval has passed', () => {
  const seen = [];
  const d = createDriftDetector({ required: KEYS, label: 'book', onDrift: (r) => seen.push(r), repeatMs: 60_000 });

  d.check({ asset_id: 'x' }, 1000);
  d.check({ asset_id: 'x' }, 60_999);
  assert.equal(seen.length, 1, 'still inside the interval');
  d.check({ asset_id: 'x' }, 61_000);
  assert.equal(seen.length, 2, 'the interval has elapsed');
});

test('a DIFFERENT set of missing keys is reported immediately, not suppressed', () => {
  // Suppressing by "is drifting" rather than by "what drifted" would hide a second,
  // unrelated schema change behind the first one for a whole repeat interval.
  const seen = [];
  const d = createDriftDetector({ required: KEYS, label: 'book', onDrift: (r) => seen.push(r), repeatMs: 60_000 });

  d.check({ asset_id: 'x' }, 1000);
  d.check({ asks: [] }, 1001);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1].missing, ['asset_id']);
});

test('a clean payload reports nothing and clears the suppression', () => {
  const seen = [];
  const d = createDriftDetector({ required: KEYS, label: 'book', onDrift: (r) => seen.push(r), repeatMs: 60_000 });

  d.check({ asset_id: 'x' }, 1000);
  assert.equal(d.check({ asset_id: 'x', asks: [] }, 1002), true);
  assert.equal(seen.length, 1);

  // Recovered, then drifted again inside the repeat window: this is a NEW event and the
  // operator needs it, so recovery must reset the timer rather than leave it armed.
  d.check({ asset_id: 'x' }, 1003);
  assert.equal(seen.length, 2);
});

test('the detector counts what it has seen, so a quiet run is distinguishable from a dead one', () => {
  const d = createDriftDetector({ required: KEYS, label: 'book', onDrift: () => {} });
  d.check({ asset_id: 'x', asks: [] }, 1);
  d.check({ asset_id: 'x' }, 2);
  d.check({ asset_id: 'x', asks: [] }, 3);
  assert.deepEqual(d.stats(), { checked: 3, drifted: 1, reported: 1 });
});

test('an onDrift callback that throws cannot break the caller', () => {
  // The detector sits inside the message hot path. A broken alert sink must not take the
  // scanner down with it.
  const d = createDriftDetector({
    required: KEYS,
    label: 'book',
    onDrift: () => {
      throw new Error('sink exploded');
    },
  });
  assert.doesNotThrow(() => d.check({ asset_id: 'x' }, 1000));
  assert.equal(d.stats().drifted, 1);
});

test('createDriftDetector validates its own wiring at construction', () => {
  assert.throws(() => createDriftDetector({ required: 'asks', label: 'b', onDrift: () => {} }), TypeError);
  assert.throws(() => createDriftDetector({ required: KEYS, label: '', onDrift: () => {} }), TypeError);
  assert.throws(() => createDriftDetector({ required: KEYS, label: 'b', onDrift: 'nope' }), TypeError);
  assert.throws(
    () => createDriftDetector({ required: KEYS, label: 'b', onDrift: () => {}, repeatMs: -1 }),
    TypeError,
  );
});
