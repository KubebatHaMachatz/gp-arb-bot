import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_NODE_CANDIDATES,
  LABEL_PREFIX,
  assertNoSecrets,
  flagValue,
  isDurableNodePath,
  isSecretKey,
  labelFor,
  SERVICES,
  parseEnginesFloor,
  plistFor,
  plistPath,
  selectServices,
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

// ── flag parsing: never guess a missing value ───────────────────────────────

test('flagValue reads the token after the flag', () => {
  assert.deepEqual(flagValue(['--service', 'watchdog'], '--service'), {
    value: 'watchdog',
    error: null,
  });
  assert.deepEqual(flagValue(['--dry-run', '--node', '/usr/bin/node'], '--node'), {
    value: '/usr/bin/node',
    error: null,
  });
});

test('an absent flag is null with no error — not supplied is not an error', () => {
  assert.deepEqual(flagValue(['--dry-run'], '--service'), { value: null, error: null });
  assert.deepEqual(flagValue([], '--service'), { value: null, error: null });
});

test('a TRAILING value-taking flag is an error, never "not supplied"', () => {
  // This is the whole point. Falling through to "not supplied" makes a trailing
  // --service select EVERY service: an install bootstraps three LaunchAgents when one was
  // asked for, and an uninstall tears down a running measurement.
  const r = flagValue(['--dry-run', '--service'], '--service');
  assert.equal(r.value, null);
  assert.match(r.error, /--service requires a value/);
});

test('a following flag does not become the value', () => {
  // `--service --dry-run` would otherwise report `unknown service "--dry-run"`, which
  // names the wrong problem and sends the operator looking at the service list.
  const r = flagValue(['--service', '--dry-run'], '--service');
  assert.equal(r.value, null);
  assert.match(r.error, /requires a value/);
});

test('a value that merely contains dashes is fine', () => {
  assert.equal(flagValue(['--service', 'scan-polymarket'], '--service').value, 'scan-polymarket');
});

test('a negative-looking value is still a value', () => {
  // Only a leading `--` marks a flag; a single dash is not this parser's concern.
  assert.equal(flagValue(['--node', '-'], '--node').value, '-');
});

// ── the service table, shared by install and uninstall ──────────────────────

test('every service has a name, a script and an explicit byDefault', () => {
  assert.equal(Object.isFrozen(SERVICES), true);
  for (const s of SERVICES) {
    assert.equal(typeof s.name, 'string');
    assert.notEqual(s.name, '');
    assert.match(s.script, /\.mjs$/);
    assert.equal(typeof s.byDefault, 'boolean', `${s.name} must state byDefault explicitly`);
    assert.doesNotThrow(() => labelFor(s.name), `${s.name} must produce a loadable label`);
  }
});

test('service names are unique — a duplicate would install one and orphan the other', () => {
  const names = SERVICES.map((s) => s.name);
  assert.equal(new Set(names).size, names.length);
});

test('a bare install takes the default set and reports what it skipped', () => {
  const { selected, skipped, error } = selectServices(null);
  assert.equal(error, null);
  assert.deepEqual(selected.map((s) => s.name), ['scan-polymarket', 'watchdog', 'dashboard']);
  assert.deepEqual(skipped, ['scan-kalshi']);
});

test('an opt-out service is still installable when named explicitly', () => {
  // The Kalshi finding is about the public REST transport, not the venue forever. Making
  // it unreachable would bake a transport limitation into the tooling permanently.
  const { selected, error } = selectServices('scan-kalshi');
  assert.equal(error, null);
  assert.deepEqual(selected.map((s) => s.name), ['scan-kalshi']);
});

test('naming a default service selects exactly it', () => {
  assert.deepEqual(selectServices('watchdog').selected.map((s) => s.name), ['watchdog']);
});

test('an unknown service is an error listing the real ones', () => {
  const { selected, error } = selectServices('bogus');
  assert.deepEqual(selected, []);
  assert.match(error, /unknown service "bogus"/);
  assert.match(error, /scan-polymarket/);
  assert.match(error, /scan-kalshi/);
});

test('the watchdog pins its venue list rather than auto-discovering', () => {
  // Auto-discovery watches whatever has rows. One manual scan_kalshi run would then have
  // the watchdog alerting forever about a feed that is deliberately not installed.
  const watchdog = SERVICES.find((s) => s.name === 'watchdog');
  assert.equal(watchdog.environment.GPA_WATCH_VENUES, 'polymarket');
});

test('no service environment carries a credential', () => {
  // Belt and braces: plistFor would throw at render time, but a table that cannot pass
  // its own rule should fail here, where the message points at the table.
  for (const s of SERVICES) {
    assert.doesNotThrow(() => assertNoSecrets(s.environment ?? {}), s.name);
  }
});

test('every service script exists in the repo', async () => {
  // A typo here installs a LaunchAgent that cannot start: launchd retries every
  // ThrottleInterval forever and says so only in the system log.
  const { existsSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
  for (const s of SERVICES) {
    assert.equal(existsSync(join(repo, s.script)), true, `${s.name} -> ${s.script}`);
  }
});

// ── flags alongside absolute paths in ProgramArguments ─────────────────────

test('a flag carrying an absolute path is accepted', () => {
  // `--env-file-if-exists=/abs/.env` holds its path INSIDE the token, so a naive
  // startsWith('/') check on every argument would reject a perfectly valid invocation.
  const xml = plistFor({
    ...BASE,
    programArguments: [
      '/usr/local/bin/node',
      '--env-file-if-exists=/repo/.env',
      '/repo/scripts/scan_polymarket.mjs',
    ],
  });
  assert.match(xml, /<string>--env-file-if-exists=\/repo\/\.env<\/string>/);
  assert.match(xml, /<string>\/repo\/scripts\/scan_polymarket\.mjs<\/string>/);
});

test('a NON-flag argument after a flag must still be absolute', () => {
  // Exempting flags must not become exempting everything: a relative script path is
  // still a service that starts, fails to find its target, and dies in a KeepAlive loop.
  assert.throws(
    () =>
      plistFor({
        ...BASE,
        programArguments: ['/usr/local/bin/node', '--env-file-if-exists=/repo/.env', 'scripts/x.mjs'],
      }),
    /absolute/,
  );
});

test('the executable itself is never exempt, even spelled like a flag', () => {
  assert.throws(() => plistFor({ ...BASE, programArguments: ['node', '/repo/x.mjs'] }), /absolute/);
  assert.throws(() => plistFor({ ...BASE, programArguments: ['--weird', '/repo/x.mjs'] }), /absolute/);
});

// ── the version floor comes from engines, never a second literal ────────────

test('parseEnginesFloor reads the form this repo uses', () => {
  assert.deepEqual(parseEnginesFloor('>=22.9'), [22, 9]);
  assert.deepEqual(parseEnginesFloor('>=22.5'), [22, 5]);
  assert.deepEqual(parseEnginesFloor('>= 24.1'), [24, 1]);
});

test('a major-only range floors the minor at 0', () => {
  assert.deepEqual(parseEnginesFloor('>=22'), [22, 0]);
});

test('an unreadable range throws instead of guessing permissively', () => {
  // Guessing low is the dangerous direction: the installer would accept a Node that
  // cannot run the services, write the plists, and leave them crash-looping.
  for (const bad of ['^22.9', '22.9', '', null, undefined, 'latest', '>=abc']) {
    assert.throws(() => parseEnginesFloor(bad), TypeError, String(bad));
  }
});

test('the floor the installer enforces matches package.json engines', async () => {
  // These drifted apart the moment --env-file-if-exists raised the requirement, which is
  // exactly the bug this test exists to prevent recurring.
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  const floor = parseEnginesFloor(pkg.engines.node);

  // The services pass --env-file-if-exists, added in Node 22.9. A floor below that would
  // let the installer choose a Node that rejects the flag outright.
  assert.ok(
    floor[0] > 22 || (floor[0] === 22 && floor[1] >= 9),
    `engines.node is ${pkg.engines.node}, but the plists pass --env-file-if-exists (Node >= 22.9)`,
  );
});
