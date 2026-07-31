import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_NODE_CANDIDATES,
  LABEL_PREFIX,
  assertNoSecrets,
  isDurableNodePath,
  isSecretKey,
  labelFor,
  plistFor,
  plistPath,
  xmlEscape,
} from '../lib/launchd.mjs';

const BASE = Object.freeze({
  label: 'com.gp-arb-bot.scan-polymarket',
  programArguments: ['/usr/local/bin/node', '/repo/scripts/scan_polymarket.mjs'],
  workingDirectory: '/repo',
  stdoutPath: '/repo/logs/poly.log',
  stderrPath: '/repo/logs/poly.err',
});

// ── xmlEscape ───────────────────────────────────────────────────────────────

test('xmlEscape neutralises every character that can break a plist', () => {
  assert.equal(xmlEscape('a & b'), 'a &amp; b');
  assert.equal(xmlEscape('<key>'), '&lt;key&gt;');
  assert.equal(xmlEscape('say "hi"'), 'say &quot;hi&quot;');
  assert.equal(xmlEscape("it's"), 'it&apos;s');
});

test('the ampersand is escaped first, so escapes are not double-escaped', () => {
  // Replacing < before & would turn "<" into "&lt;" and then into "&amp;lt;" -- a plist
  // that parses but carries the wrong string, which is worse than one that fails to load.
  assert.equal(xmlEscape('<&>'), '&lt;&amp;&gt;');
  assert.equal(xmlEscape('&amp;'), '&amp;amp;');
});

test('xmlEscape coerces non-strings rather than throwing mid-render', () => {
  assert.equal(xmlEscape(42), '42');
  assert.equal(xmlEscape(null), 'null');
});

// ── secret detection ────────────────────────────────────────────────────────

test('isSecretKey catches the shapes a credential name actually takes', () => {
  for (const key of [
    'GPA_TELEGRAM_BOT_TOKEN',
    'KALSHI_PRIVATE_KEY',
    'POLY_API_SECRET',
    'db_password',
    'MY_PASSPHRASE',
    'AWS_CREDENTIALS',
    'auth_token',
    'PRIVATE_KEY_PATH',
  ]) {
    assert.equal(isSecretKey(key), true, key);
  }
});

test('isSecretKey does not flag ordinary knobs', () => {
  for (const key of ['GPA_DB', 'GPA_PORT', 'GPA_MIN_NET_EDGE', 'NODE_ENV', 'PATH', 'HOME']) {
    assert.equal(isSecretKey(key), false, key);
  }
});

test('assertNoSecrets refuses to render a credential into a plist', () => {
  // launchd plists live in ~/Library/LaunchAgents and are world-readable 644. A token
  // written here is a token published to every account on the machine, and it survives
  // in Time Machine backups long after the variable is rotated.
  assert.throws(
    () => assertNoSecrets({ GPA_DB: 'data/arb.db', GPA_TELEGRAM_BOT_TOKEN: 'abc123' }),
    (err) => {
      assert.match(err.message, /GPA_TELEGRAM_BOT_TOKEN/);
      assert.match(err.message, /644|world-readable/);
      assert.doesNotMatch(err.message, /abc123/, 'and the value is never echoed back');
      return true;
    },
  );
});

test('assertNoSecrets passes a clean environment', () => {
  assert.doesNotThrow(() => assertNoSecrets({ GPA_DB: 'data/arb.db', GPA_PORT: '4324' }));
  assert.doesNotThrow(() => assertNoSecrets({}));
});

test('assertNoSecrets names every offending key, not just the first', () => {
  assert.throws(
    () => assertNoSecrets({ A_TOKEN: '1', B_SECRET: '2' }),
    (err) => {
      assert.match(err.message, /A_TOKEN/);
      assert.match(err.message, /B_SECRET/);
      return true;
    },
  );
});

// ── labels and paths ────────────────────────────────────────────────────────

test('labelFor builds a reverse-DNS label under this repo prefix', () => {
  assert.equal(labelFor('scan-polymarket'), `${LABEL_PREFIX}.scan-polymarket`);
});

test('labelFor rejects a name that would produce an unloadable label', () => {
  // launchd silently refuses labels with a path separator, and a space makes the
  // launchctl invocation ambiguous. Both fail at load time with no useful message.
  for (const bad of ['scan polymarket', 'scan/poly', '', '   ', 'scan\tpoly', null, 42]) {
    assert.throws(() => labelFor(bad), TypeError, String(bad));
  }
});

test('plistPath places the file where a per-user LaunchAgent belongs', () => {
  assert.equal(
    plistPath('com.gp-arb-bot.scan-polymarket', '/Users/x'),
    '/Users/x/Library/LaunchAgents/com.gp-arb-bot.scan-polymarket.plist',
  );
});

// ── the rendered plist ──────────────────────────────────────────────────────

test('plistFor renders a loadable document with the required keys', () => {
  const xml = plistFor(BASE);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<!DOCTYPE plist PUBLIC/);
  assert.match(xml, /<key>Label<\/key>\s*<string>com\.gp-arb-bot\.scan-polymarket<\/string>/);
  assert.match(xml, /<key>ProgramArguments<\/key>/);
  assert.match(xml, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(xml, /<string>\/repo\/scripts\/scan_polymarket\.mjs<\/string>/);
  assert.match(xml, /<key>WorkingDirectory<\/key>\s*<string>\/repo<\/string>/);
  assert.match(xml, /<\/plist>\n?$/);
});

test('the service restarts itself and survives a reboot', () => {
  // A measurement run that silently stops at the first crash produces a partial week
  // indistinguishable from a complete one -- which is the input to the Phase 2 decision.
  const xml = plistFor(BASE);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
});

test('a throttle interval is set, so a crash loop cannot spin the CPU', () => {
  const xml = plistFor(BASE);
  assert.match(xml, /<key>ThrottleInterval<\/key>\s*<integer>\d+<\/integer>/);
});

test('a path containing XML metacharacters is escaped, not injected', () => {
  // A repo checked out under "R&D" would otherwise emit a plist that fails to parse --
  // and launchd's diagnostic for that is a bare "Load failed: 5: Input/output error".
  const xml = plistFor({ ...BASE, workingDirectory: '/Users/x/R&D/<repo>' });
  assert.match(xml, /<string>\/Users\/x\/R&amp;D\/&lt;repo&gt;<\/string>/);
  assert.doesNotMatch(xml, /R&D/);
});

test('environment variables are rendered when given', () => {
  const xml = plistFor({ ...BASE, environment: { GPA_DB: '/repo/data/arb.db', GPA_PORT: '4324' } });
  assert.match(xml, /<key>EnvironmentVariables<\/key>/);
  assert.match(xml, /<key>GPA_DB<\/key>\s*<string>\/repo\/data\/arb\.db<\/string>/);
});

test('the EnvironmentVariables block is omitted entirely when there is nothing to set', () => {
  assert.doesNotMatch(plistFor(BASE), /EnvironmentVariables/);
  assert.doesNotMatch(plistFor({ ...BASE, environment: {} }), /EnvironmentVariables/);
});

test('plistFor refuses an environment carrying a secret', () => {
  assert.throws(
    () => plistFor({ ...BASE, environment: { GPA_TELEGRAM_BOT_TOKEN: 'shh' } }),
    /GPA_TELEGRAM_BOT_TOKEN/,
  );
});

test('plistFor validates the arguments a broken service would fail on at load time', () => {
  assert.throws(() => plistFor({ ...BASE, label: '' }), TypeError);
  assert.throws(() => plistFor({ ...BASE, programArguments: [] }), TypeError);
  assert.throws(() => plistFor({ ...BASE, programArguments: '/usr/bin/node' }), TypeError);
  assert.throws(() => plistFor({ ...BASE, programArguments: ['/usr/bin/node', 42] }), TypeError);
  assert.throws(() => plistFor({ ...BASE, workingDirectory: '' }), TypeError);
  assert.throws(() => plistFor({ ...BASE, throttleSeconds: 0 }), TypeError);
  assert.throws(() => plistFor({ ...BASE, throttleSeconds: 1.5 }), TypeError);
});

test('a single-element programArguments is accepted — not every service takes a script', () => {
  // The second-argument check must be conditional; a one-element array is a valid
  // ProgramArguments and would otherwise throw on an index that is not there.
  const xml = plistFor({ ...BASE, programArguments: ['/usr/local/bin/some-daemon'] });
  assert.match(xml, /<string>\/usr\/local\/bin\/some-daemon<\/string>/);
});

test('a custom throttle interval is honoured', () => {
  assert.match(plistFor({ ...BASE, throttleSeconds: 30 }), /<integer>30<\/integer>/);
});

test('every path in the plist is absolute — launchd has no working directory of its own', () => {
  // A relative path in a LaunchAgent resolves against "/", so the service starts, fails
  // to find its script, and dies in a KeepAlive loop that only shows up in system logs.
  for (const field of ['workingDirectory', 'stdoutPath', 'stderrPath']) {
    assert.throws(() => plistFor({ ...BASE, [field]: 'relative/path' }), /absolute/, field);
  }
  assert.throws(() => plistFor({ ...BASE, programArguments: ['node', '/repo/s.mjs'] }), /absolute/);
});

// ── choosing a node binary that will still exist next month ─────────────────

const HOME = '/Users/x';

test('a node under a system prefix is durable', () => {
  for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
    assert.equal(isDurableNodePath(p, HOME), true, p);
  }
});

test('a node inside a hidden directory under $HOME is NOT durable', () => {
  // This is the whole point. Per-user version managers and tool-managed runtimes move,
  // upgrade and vanish; a launchd plist pointing into one breaks permanently and
  // silently -- launchd cannot spawn, KeepAlive retries every ThrottleInterval forever,
  // and the only trace is the system log.
  for (const p of [
    '/Users/x/.hermes/node/bin/node',
    '/Users/x/.nvm/versions/node/v22.5.0/bin/node',
    '/Users/x/.volta/tools/image/node/22.5.0/bin/node',
    '/Users/x/.asdf/installs/nodejs/22.5.0/bin/node',
    '/Users/x/.fnm/node-versions/v22.5.0/installation/bin/node',
    '/Users/x/.local/bin/node',
  ]) {
    assert.equal(isDurableNodePath(p, HOME), false, p);
  }
});

test('a visible directory under $HOME is durable — hidden is the signal, not "under home"', () => {
  assert.equal(isDurableNodePath('/Users/x/bin/node', HOME), true);
  assert.equal(isDurableNodePath('/Users/x/tools/node/bin/node', HOME), true);
});

test('a hidden directory OUTSIDE $HOME is left alone', () => {
  // The rule targets per-user runtime managers. A system path is not this script's
  // business to second-guess.
  assert.equal(isDurableNodePath('/opt/.internal/bin/node', HOME), true);
});

test('isDurableNodePath is not fooled by a home-prefix collision', () => {
  // "/Users/xyz" starts with "/Users/x" as a STRING but is a different user's home.
  assert.equal(isDurableNodePath('/Users/xyz/.nvm/bin/node', HOME), true);
});

test('isDurableNodePath handles a home with a trailing slash', () => {
  assert.equal(isDurableNodePath('/Users/x/.nvm/bin/node', '/Users/x/'), false);
});

test('DEFAULT_NODE_CANDIDATES lists durable system prefixes, most-preferred first', () => {
  assert.ok(Array.isArray(DEFAULT_NODE_CANDIDATES));
  assert.ok(DEFAULT_NODE_CANDIDATES.length > 0);
  for (const p of DEFAULT_NODE_CANDIDATES) {
    assert.equal(p.startsWith('/'), true, p);
    assert.equal(isDurableNodePath(p, HOME), true, p);
  }
});
