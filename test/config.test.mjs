import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULTS,
  loadConfig,
  parseBooleanEnv,
  parseFloatEnv,
  parseIntegerEnv,
  parseStringEnv,
} from '../lib/config.mjs';

// ── parseIntegerEnv ─────────────────────────────────────────────────────────

test('parseIntegerEnv returns the default when the var is unset', () => {
  assert.equal(parseIntegerEnv(undefined, { name: 'GPA_X', def: 7 }), 7);
  assert.equal(parseIntegerEnv(null, { name: 'GPA_X', def: 7 }), 7);
});

test('parseIntegerEnv treats blank and whitespace-only as unset', () => {
  assert.equal(parseIntegerEnv('', { name: 'GPA_X', def: 7 }), 7);
  assert.equal(parseIntegerEnv('   ', { name: 'GPA_X', def: 7 }), 7);
  assert.equal(parseIntegerEnv('\t\n', { name: 'GPA_X', def: 7 }), 7);
});

test('parseIntegerEnv parses a well-formed integer, trimming surrounding space', () => {
  assert.equal(parseIntegerEnv('42', { name: 'GPA_X', def: 7 }), 42);
  assert.equal(parseIntegerEnv('  42  ', { name: 'GPA_X', def: 7 }), 42);
  assert.equal(parseIntegerEnv('0', { name: 'GPA_X', def: 7 }), 0);
  assert.equal(parseIntegerEnv('-5', { name: 'GPA_X', def: 7 }), -5);
  assert.equal(parseIntegerEnv('+5', { name: 'GPA_X', def: 7 }), 5);
});

test('parseIntegerEnv rejects anything that is not a plain integer', () => {
  for (const bad of ['1.5', '1e3', '0x10', 'abc', '1 2', '--5', 'NaN', 'Infinity', '1_000']) {
    assert.throws(
      () => parseIntegerEnv(bad, { name: 'GPA_X', def: 7 }),
      /GPA_X must be an integer/,
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

test('parseIntegerEnv rejects an integer beyond safe-integer range', () => {
  assert.throws(
    () => parseIntegerEnv('9007199254740993', { name: 'GPA_X', def: 7 }),
    /GPA_X must be an integer/,
  );
});

test('parseIntegerEnv enforces an inclusive minimum and maximum', () => {
  assert.equal(parseIntegerEnv('5', { name: 'GPA_X', def: 7, min: 5, max: 9 }), 5);
  assert.equal(parseIntegerEnv('9', { name: 'GPA_X', def: 7, min: 5, max: 9 }), 9);
  assert.throws(
    () => parseIntegerEnv('4', { name: 'GPA_X', def: 7, min: 5, max: 9 }),
    /GPA_X must be >= 5, got 4/,
  );
  assert.throws(
    () => parseIntegerEnv('10', { name: 'GPA_X', def: 7, min: 5, max: 9 }),
    /GPA_X must be <= 9, got 10/,
  );
});

test('parseIntegerEnv error message quotes the offending raw value', () => {
  assert.throws(() => parseIntegerEnv('abc', { name: 'GPA_PORT', def: 1 }), /got "abc"/);
});

// ── parseFloatEnv ───────────────────────────────────────────────────────────

test('parseFloatEnv returns the default when unset or blank', () => {
  assert.equal(parseFloatEnv(undefined, { name: 'GPA_X', def: 0.5 }), 0.5);
  assert.equal(parseFloatEnv('  ', { name: 'GPA_X', def: 0.5 }), 0.5);
});

test('parseFloatEnv parses decimals, integers and leading-dot forms', () => {
  assert.equal(parseFloatEnv('0.25', { name: 'GPA_X', def: 1 }), 0.25);
  assert.equal(parseFloatEnv('3', { name: 'GPA_X', def: 1 }), 3);
  assert.equal(parseFloatEnv('.5', { name: 'GPA_X', def: 1 }), 0.5);
  assert.equal(parseFloatEnv('  1.5  ', { name: 'GPA_X', def: 1 }), 1.5);
});

test('parseFloatEnv rejects non-finite and non-numeric values', () => {
  for (const bad of ['abc', 'NaN', 'Infinity', '-Infinity', '1e999', '1,5', '1.2.3']) {
    assert.throws(
      () => parseFloatEnv(bad, { name: 'GPA_X', def: 1 }),
      /GPA_X must be a finite number/,
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

test('parseFloatEnv enforces an inclusive minimum by default', () => {
  assert.equal(parseFloatEnv('0', { name: 'GPA_X', def: 1, min: 0 }), 0);
  assert.throws(
    () => parseFloatEnv('-0.1', { name: 'GPA_X', def: 1, min: 0 }),
    /GPA_X must be >= 0, got -0.1/,
  );
});

test('parseFloatEnv supports an EXCLUSIVE minimum, which rejects the bound itself', () => {
  assert.throws(
    () => parseFloatEnv('0', { name: 'GPA_X', def: 0.5, minExclusive: 0, max: 1 }),
    /GPA_X must be > 0, got 0/,
  );
  assert.equal(parseFloatEnv('0.0001', { name: 'GPA_X', def: 0.5, minExclusive: 0, max: 1 }), 0.0001);
  assert.equal(parseFloatEnv('1', { name: 'GPA_X', def: 0.5, minExclusive: 0, max: 1 }), 1);
  assert.throws(
    () => parseFloatEnv('1.1', { name: 'GPA_X', def: 0.5, minExclusive: 0, max: 1 }),
    /GPA_X must be <= 1, got 1.1/,
  );
});

// ── parseBooleanEnv ─────────────────────────────────────────────────────────

test('parseBooleanEnv accepts the documented truthy and falsy spellings', () => {
  for (const raw of ['true', 'TRUE', 'True', '1', 'yes', 'YES', 'on', 'ON']) {
    assert.equal(parseBooleanEnv(raw, { name: 'GPA_X', def: false }), true, raw);
  }
  for (const raw of ['false', 'FALSE', 'False', '0', 'no', 'NO', 'off', 'OFF']) {
    assert.equal(parseBooleanEnv(raw, { name: 'GPA_X', def: true }), false, raw);
  }
});

test('parseBooleanEnv returns the default when unset or blank', () => {
  assert.equal(parseBooleanEnv(undefined, { name: 'GPA_X', def: true }), true);
  assert.equal(parseBooleanEnv('  ', { name: 'GPA_X', def: false }), false);
});

test('parseBooleanEnv rejects an unrecognised spelling rather than guessing', () => {
  for (const bad of ['y', 'n', 'truthy', '2', 'enabled']) {
    assert.throws(
      () => parseBooleanEnv(bad, { name: 'GPA_X', def: false }),
      /GPA_X must be a boolean/,
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

// ── parseStringEnv ──────────────────────────────────────────────────────────

test('parseStringEnv trims and returns the default when unset or blank', () => {
  assert.equal(parseStringEnv(undefined, { name: 'GPA_X', def: 'd' }), 'd');
  assert.equal(parseStringEnv('   ', { name: 'GPA_X', def: 'd' }), 'd');
  assert.equal(parseStringEnv('  v  ', { name: 'GPA_X', def: 'd' }), 'v');
});

// ── loadConfig: defaults ────────────────────────────────────────────────────

test('loadConfig on an empty env produces the documented defaults', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.db, 'data/arb.db');
  assert.equal(cfg.bookStaleMs, 750);
  assert.equal(cfg.minNetEdge, 0.005);
  assert.equal(cfg.maxSetSizeUsd, 250);
  assert.equal(cfg.depthSafetyFactor, 0.5);
  assert.equal(cfg.keepOppDays, 90);
  assert.equal(cfg.dbBusyTimeoutMs, 5000);
  assert.equal(cfg.bind, '127.0.0.1');
  assert.equal(cfg.port, 4324);
  assert.deepEqual(cfg.lockPorts, {
    polymarket: 43241,
    kalshi: 43242,
    limitless: 43243,
    // The watchdog owns the retention sweep, so it writes too and needs a lock of its own.
    watchdog: 43244,
  });
});

test('DEFAULTS is exported and agrees with what loadConfig({}) produces', () => {
  // DEFAULTS documents the same literals the assertions above hand-check.
  assert.equal(DEFAULTS.GPA_DB, 'data/arb.db');
  assert.equal(DEFAULTS.GPA_BOOK_STALE_MS, 750);
  assert.equal(DEFAULTS.GPA_MIN_NET_EDGE, 0.005);
  assert.equal(DEFAULTS.GPA_MAX_SET_SIZE_USD, 250);
  assert.equal(DEFAULTS.GPA_DEPTH_SAFETY_FACTOR, 0.5);
  assert.equal(DEFAULTS.GPA_MISS_SAMPLE_MS, 300000);
  assert.equal(DEFAULTS.GPA_REDISCOVER_MS, 900000);
  assert.equal(DEFAULTS.GPA_KEEP_OPP_DAYS, 90);
  assert.equal(DEFAULTS.GPA_DB_BUSY_TIMEOUT_MS, 5000);
  assert.equal(DEFAULTS.GPA_BIND, '127.0.0.1');
  assert.equal(DEFAULTS.GPA_PORT, 4324);
  assert.equal(DEFAULTS.GPA_LOCK_PORT_POLYMARKET, 43241);
  assert.equal(DEFAULTS.GPA_LOCK_PORT_KALSHI, 43242);
  assert.equal(DEFAULTS.GPA_LOCK_PORT_LIMITLESS, 43243);
  assert.equal(DEFAULTS.GPA_LOCK_PORT_WATCHDOG, 43244);
  assert.equal(DEFAULTS.GPA_WATCHDOG_INTERVAL_MS, 60000);
  assert.equal(DEFAULTS.GPA_WATCHDOG_REPEAT_MS, 1800000);
  assert.equal(Object.isFrozen(DEFAULTS), true);
});

test('loadConfig returns a deeply frozen object', () => {
  const cfg = loadConfig({});
  assert.equal(Object.isFrozen(cfg), true);
  assert.equal(Object.isFrozen(cfg.lockPorts), true);
  assert.throws(() => {
    cfg.port = 1;
  }, TypeError);
  assert.throws(() => {
    cfg.lockPorts.kalshi = 1;
  }, TypeError);
});

test('loadConfig reads every knob from the env it is handed', () => {
  const cfg = loadConfig({
    GPA_DB: '/tmp/x.db',
    GPA_BOOK_STALE_MS: '250',
    GPA_MIN_NET_EDGE: '0.02',
    GPA_MAX_SET_SIZE_USD: '1000',
    GPA_DEPTH_SAFETY_FACTOR: '0.25',
    GPA_KEEP_OPP_DAYS: '30',
    GPA_DB_BUSY_TIMEOUT_MS: '30000',
    GPA_BIND: '0.0.0.0',
    GPA_PORT: '8080',
    GPA_LOCK_PORT_POLYMARKET: '43001',
    GPA_LOCK_PORT_KALSHI: '43002',
    GPA_LOCK_PORT_LIMITLESS: '43003',
    GPA_LOCK_PORT_WATCHDOG: '43004',
    GPA_WATCHDOG_INTERVAL_MS: '15000',
    GPA_WATCHDOG_REPEAT_MS: '600000',
  });
  assert.equal(cfg.db, '/tmp/x.db');
  assert.equal(cfg.bookStaleMs, 250);
  assert.equal(cfg.minNetEdge, 0.02);
  assert.equal(cfg.maxSetSizeUsd, 1000);
  assert.equal(cfg.depthSafetyFactor, 0.25);
  assert.equal(cfg.keepOppDays, 30);
  assert.equal(cfg.dbBusyTimeoutMs, 30000);
  assert.equal(cfg.bind, '0.0.0.0');
  assert.equal(cfg.port, 8080);
  assert.deepEqual(cfg.lockPorts, {
    polymarket: 43001,
    kalshi: 43002,
    limitless: 43003,
    watchdog: 43004,
  });
  assert.equal(cfg.watchdogIntervalMs, 15000);
  assert.equal(cfg.watchdogRepeatMs, 600000);
});

test('loadConfig ignores env vars it does not own', () => {
  const cfg = loadConfig({ PATH: '/usr/bin', PMM_DB: 'other.db', GPA_NOT_A_KNOB: 'x' });
  assert.equal(cfg.db, 'data/arb.db');
});

// ── loadConfig: unset vs set-but-invalid ────────────────────────────────────

test('an UNSET var uses its default but a SET-BUT-INVALID var throws', () => {
  // The distinction this repo's rules turn on: a missing knob is fine, a
  // misconfigured one is a startup crash, never a silent fallback.
  assert.equal(loadConfig({}).port, 4324);
  assert.throws(() => loadConfig({ GPA_PORT: 'not-a-port' }), /GPA_PORT must be an integer/);

  assert.equal(loadConfig({}).minNetEdge, 0.005);
  assert.throws(() => loadConfig({ GPA_MIN_NET_EDGE: 'wat' }), /GPA_MIN_NET_EDGE must be a finite number/);
});

// ── loadConfig: the range rules that must not be copy-pasted onto each other ─

test('GPA_DEPTH_SAFETY_FACTOR of exactly 0 is INVALID — it would size every trade to zero', () => {
  assert.throws(
    () => loadConfig({ GPA_DEPTH_SAFETY_FACTOR: '0' }),
    /GPA_DEPTH_SAFETY_FACTOR must be > 0, got 0/,
  );
});

test('GPA_DB_BUSY_TIMEOUT_MS of exactly 0 IS valid — SQLite\'s fail-immediately mode', () => {
  assert.equal(loadConfig({ GPA_DB_BUSY_TIMEOUT_MS: '0' }).dbBusyTimeoutMs, 0);
});

test('GPA_MIN_NET_EDGE and GPA_DEPTH_SAFETY_FACTOR are both bounded to (0, 1]', () => {
  for (const name of ['GPA_MIN_NET_EDGE', 'GPA_DEPTH_SAFETY_FACTOR']) {
    assert.throws(() => loadConfig({ [name]: '0' }), new RegExp(`${name} must be > 0`));
    assert.throws(() => loadConfig({ [name]: '-0.1' }), new RegExp(`${name} must be > 0`));
    assert.throws(() => loadConfig({ [name]: '1.01' }), new RegExp(`${name} must be <= 1`));
    // the inclusive upper bound itself is accepted
    assert.doesNotThrow(() => loadConfig({ [name]: '1' }));
  }
});

test('GPA_BOOK_STALE_MS must be at least 1 — a 0ms gate would reject every book', () => {
  assert.throws(() => loadConfig({ GPA_BOOK_STALE_MS: '0' }), /GPA_BOOK_STALE_MS must be >= 1, got 0/);
  assert.equal(loadConfig({ GPA_BOOK_STALE_MS: '1' }).bookStaleMs, 1);
});

test('GPA_BOOK_STALE_MS is capped — a huge value is no gate at all, not a lenient one', () => {
  // The gate decides whether money is committed against a book image that may already
  // be gone. Bounded in BOTH directions on purpose: 999999999ms is an 11-day "freshness"
  // window, which silently disarms the guard rather than loosening it.
  assert.equal(loadConfig({ GPA_BOOK_STALE_MS: '60000' }).bookStaleMs, 60000);
  assert.throws(
    () => loadConfig({ GPA_BOOK_STALE_MS: '60001' }),
    /GPA_BOOK_STALE_MS must be <= 60000, got 60001/,
  );
  assert.throws(
    () => loadConfig({ GPA_BOOK_STALE_MS: '999999999' }),
    /GPA_BOOK_STALE_MS must be <= 60000, got 999999999/,
  );
});

test('GPA_MAX_SET_SIZE_USD must be strictly positive', () => {
  assert.throws(() => loadConfig({ GPA_MAX_SET_SIZE_USD: '0' }), /GPA_MAX_SET_SIZE_USD must be > 0/);
  assert.throws(() => loadConfig({ GPA_MAX_SET_SIZE_USD: '-5' }), /GPA_MAX_SET_SIZE_USD must be > 0/);
});

test('GPA_MISS_SAMPLE_MS bounds how often a NON-clearing set is re-recorded', () => {
  // 0 is valid here and means "record every miss" -- a diagnostic setting. It is not
  // the same rule as GPA_DEPTH_SAFETY_FACTOR, where 0 is meaningless.
  assert.equal(loadConfig({}).missSampleMs, 300000);
  assert.equal(loadConfig({ GPA_MISS_SAMPLE_MS: '0' }).missSampleMs, 0);
  assert.equal(loadConfig({ GPA_MISS_SAMPLE_MS: '60000' }).missSampleMs, 60000);
  assert.throws(() => loadConfig({ GPA_MISS_SAMPLE_MS: '-1' }), /GPA_MISS_SAMPLE_MS must be >= 0/);
  assert.throws(() => loadConfig({ GPA_MISS_SAMPLE_MS: 'soon' }), /GPA_MISS_SAMPLE_MS must be an integer/);
});

test('GPA_REDISCOVER_MS is floored well above zero', () => {
  // Each pass is a full paginated crawl; a tiny interval would hammer the venue and
  // starve the scan loop.
  assert.equal(loadConfig({}).rediscoverMs, 900000);
  assert.equal(loadConfig({ GPA_REDISCOVER_MS: '60000' }).rediscoverMs, 60000);
  assert.throws(() => loadConfig({ GPA_REDISCOVER_MS: '59999' }), /GPA_REDISCOVER_MS must be >= 60000/);
  assert.throws(() => loadConfig({ GPA_REDISCOVER_MS: '0' }), /GPA_REDISCOVER_MS must be >= 60000/);
});

test('GPA_KEEP_OPP_DAYS accepts 0 as "retention disabled" but rejects negatives', () => {
  assert.equal(loadConfig({ GPA_KEEP_OPP_DAYS: '0' }).keepOppDays, 0);
  assert.throws(() => loadConfig({ GPA_KEEP_OPP_DAYS: '-1' }), /GPA_KEEP_OPP_DAYS must be >= 0/);
});

test('every port knob is bounded to 1024-65535', () => {
  const portVars = [
    'GPA_PORT',
    'GPA_LOCK_PORT_POLYMARKET',
    'GPA_LOCK_PORT_KALSHI',
    'GPA_LOCK_PORT_LIMITLESS',
  ];
  for (const name of portVars) {
    assert.throws(() => loadConfig({ [name]: '1023' }), new RegExp(`${name} must be >= 1024`));
    assert.throws(() => loadConfig({ [name]: '65536' }), new RegExp(`${name} must be <= 65535`));
    assert.throws(() => loadConfig({ [name]: '80' }), new RegExp(`${name} must be >= 1024`));
  }
});

// ── loadConfig: cross-field validation ──────────────────────────────────────

test('two lock ports set to the same number is rejected, not silently accepted', () => {
  // Sharing a lock port means the second scanner silently refuses to start and
  // that venue is never collected — a failure with no error anywhere.
  assert.throws(
    () => loadConfig({ GPA_LOCK_PORT_KALSHI: '43241' }),
    /GPA_LOCK_PORT_POLYMARKET and GPA_LOCK_PORT_KALSHI must differ \(both 43241\)/,
  );
  assert.throws(
    () => loadConfig({ GPA_LOCK_PORT_LIMITLESS: '43242' }),
    /GPA_LOCK_PORT_KALSHI and GPA_LOCK_PORT_LIMITLESS must differ \(both 43242\)/,
  );
});

test('a lock port colliding with the dashboard port is rejected', () => {
  assert.throws(
    () => loadConfig({ GPA_PORT: '43241' }),
    /GPA_PORT and GPA_LOCK_PORT_POLYMARKET must differ \(both 43241\)/,
  );
});

test('loadConfig defaults to process.env when called with no argument', () => {
  const saved = process.env.GPA_PORT;
  try {
    process.env.GPA_PORT = '5555';
    assert.equal(loadConfig().port, 5555);
  } finally {
    if (saved === undefined) delete process.env.GPA_PORT;
    else process.env.GPA_PORT = saved;
  }
});

// ── watchdog and feed-staleness knobs ───────────────────────────────────────

test('the feed-staleness thresholds default per venue, not to one shared number', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.feedStaleMs.polymarket, DEFAULTS.GPA_FEED_STALE_MS_POLYMARKET);
  assert.equal(cfg.feedStaleMs.kalshi, DEFAULTS.GPA_FEED_STALE_MS_KALSHI);
  assert.notEqual(cfg.feedStaleMs.polymarket, cfg.feedStaleMs.kalshi);
  assert.equal(Object.isFrozen(cfg.feedStaleMs), true);
});

test('each feed threshold is overridable on its own', () => {
  const cfg = loadConfig({ GPA_FEED_STALE_MS_KALSHI: '2400000' });
  assert.equal(cfg.feedStaleMs.kalshi, 2_400_000);
  assert.equal(cfg.feedStaleMs.polymarket, DEFAULTS.GPA_FEED_STALE_MS_POLYMARKET);
});

test('a staleness threshold at or below the sampling period is a startup crash', () => {
  // The two knobs are coupled and neither is suspicious alone. Left to run, this
  // combination alerts on a perfectly healthy feed every few minutes until it is muted.
  assert.throws(
    () => loadConfig({ GPA_FEED_STALE_MS_POLYMARKET: '60000' }),
    (err) => {
      assert.match(err.message, /polymarket/);
      assert.match(err.message, /GPA_MISS_SAMPLE_MS/);
      return true;
    },
  );
  assert.throws(() => loadConfig({ GPA_MISS_SAMPLE_MS: '3600000' }), /GPA_MISS_SAMPLE_MS/);
});

test('raising the sampling period is fine when the thresholds are raised with it', () => {
  const cfg = loadConfig({
    GPA_MISS_SAMPLE_MS: '3600000',
    GPA_FEED_STALE_MS_POLYMARKET: '7200000',
    GPA_FEED_STALE_MS_KALSHI: '7200000',
    GPA_FEED_STALE_MS_LIMITLESS: '7200000',
  });
  assert.equal(cfg.missSampleMs, 3_600_000);
  assert.equal(cfg.feedStaleMs.polymarket, 7_200_000);
});

test('sampling disabled with 0 imposes no floor on the thresholds', () => {
  const cfg = loadConfig({ GPA_MISS_SAMPLE_MS: '0', GPA_FEED_STALE_MS_POLYMARKET: '1000' });
  assert.equal(cfg.feedStaleMs.polymarket, 1000);
});

test('a zero feed-staleness threshold is rejected — it would declare every feed dead', () => {
  assert.throws(() => loadConfig({ GPA_FEED_STALE_MS_KALSHI: '0' }), /GPA_FEED_STALE_MS_KALSHI/);
});

test('the watchdog interval is floored well above zero', () => {
  assert.equal(loadConfig({}).watchdogIntervalMs, DEFAULTS.GPA_WATCHDOG_INTERVAL_MS);
  assert.equal(loadConfig({ GPA_WATCHDOG_INTERVAL_MS: '30000' }).watchdogIntervalMs, 30_000);
  assert.throws(() => loadConfig({ GPA_WATCHDOG_INTERVAL_MS: '10' }), /GPA_WATCHDOG_INTERVAL_MS/);
});

test('the watchdog repeat interval accepts 0, which re-reports on every check', () => {
  // Valid but hostile, exactly like GPA_MISS_SAMPLE_MS=0. Accepted because it is a
  // coherent request; documented because it is rarely what anyone wants.
  assert.equal(loadConfig({ GPA_WATCHDOG_REPEAT_MS: '0' }).watchdogRepeatMs, 0);
  assert.throws(() => loadConfig({ GPA_WATCHDOG_REPEAT_MS: '-1' }), /GPA_WATCHDOG_REPEAT_MS/);
});

test('the startup-ping gap defaults small enough that a real restart is still announced', () => {
  assert.equal(loadConfig({}).startupPingMinGapMs, DEFAULTS.GPA_STARTUP_PING_MIN_GAP_MS);
  assert.equal(loadConfig({ GPA_STARTUP_PING_MIN_GAP_MS: '0' }).startupPingMinGapMs, 0);
  assert.throws(() => loadConfig({ GPA_STARTUP_PING_MIN_GAP_MS: '-1' }), /GPA_STARTUP_PING_MIN_GAP_MS/);
});
