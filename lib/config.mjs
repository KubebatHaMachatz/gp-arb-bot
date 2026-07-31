/**
 * `GPA_*` environment configuration.
 *
 * One rule shapes this whole module: **an unset knob uses its default; a knob that is
 * set to something invalid is a startup crash.** Never a silent fallback. A bot quietly
 * running on a default the operator thought they had overridden is the failure mode that
 * costs money without leaving a trace, so every parser here names the offending variable
 * and quotes the offending value.
 *
 * Blank and whitespace-only values count as UNSET (`GPA_PORT=` in a `.env` means "I did
 * not set this"), which is the one place a fallback is correct.
 *
 * `loadConfig` is pure with respect to the env object it is handed — nothing here reads
 * `process.env` except the default argument — so the whole surface is testable without
 * mutating global state.
 */

import { DEFAULT_FEED_STALE_MS, assertThresholdsExceedSampling } from './watchdog.mjs';

/**
 * Documented default for every knob, keyed by env-var name.
 *
 * The feed-staleness defaults are re-exported from `lib/watchdog.mjs` rather than
 * restated: the watchdog's tests assert properties of those numbers (that they differ per
 * venue, that they clear the sampling period), and a second copy here is how the two
 * would quietly disagree.
 */
export const DEFAULTS = Object.freeze({
  GPA_DB: 'data/arb.db',
  GPA_BOOK_STALE_MS: 750,
  GPA_MIN_NET_EDGE: 0.005,
  GPA_MAX_SET_SIZE_USD: 250,
  GPA_DEPTH_SAFETY_FACTOR: 0.5,
  GPA_MISS_SAMPLE_MS: 300000,
  GPA_REDISCOVER_MS: 900000,
  GPA_KEEP_OPP_DAYS: 90,
  GPA_DB_BUSY_TIMEOUT_MS: 5000,
  GPA_BIND: '127.0.0.1',
  GPA_PORT: 4324,
  GPA_LOCK_PORT_POLYMARKET: 43241,
  GPA_LOCK_PORT_KALSHI: 43242,
  GPA_LOCK_PORT_LIMITLESS: 43243,
  GPA_LOCK_PORT_WATCHDOG: 43244,
  GPA_WATCHDOG_INTERVAL_MS: 60000,
  GPA_WATCHDOG_REPEAT_MS: 1800000,
  GPA_FEED_STALE_MS_POLYMARKET: DEFAULT_FEED_STALE_MS.polymarket,
  GPA_FEED_STALE_MS_KALSHI: DEFAULT_FEED_STALE_MS.kalshi,
  GPA_FEED_STALE_MS_LIMITLESS: DEFAULT_FEED_STALE_MS.limitless,
});

const INTEGER_RE = /^[+-]?\d+$/;
const FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const FALSY = new Set(['false', '0', 'no', 'off']);

const MIN_PORT = 1024;
const MAX_PORT = 65535;

/**
 * Upper bound on the freshness gate.
 *
 * This is the knob that decides whether real money is committed against a book image
 * that may already be gone, so it is bounded in BOTH directions. Without a ceiling,
 * `GPA_BOOK_STALE_MS=999999999` is accepted and yields an 11-day "freshness" gate —
 * which is not a lenient gate, it is no gate at all, silently. One minute is already far
 * past any defensible value (the working figure is 750ms); anything above it is a typo
 * or a misunderstanding, and either way should stop startup rather than disarm the guard.
 */
const MAX_BOOK_STALE_MS = 60_000;

/**
 * Normalise a raw env value: `undefined`/`null`/blank all mean "unset".
 *
 * @param {string|undefined|null} raw
 * @returns {string|null} the trimmed value, or `null` when unset
 */
function trimmedOrNull(raw) {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Apply the inclusive/exclusive range rules shared by the numeric parsers.
 *
 * @param {number} value
 * @param {{name: string, min?: number, minExclusive?: number, max?: number}} opts
 * @returns {number} `value`, unchanged
 * @throws {Error} naming the variable and the bound it violated
 */
function assertInRange(value, { name, min, minExclusive, max }) {
  if (minExclusive !== undefined && !(value > minExclusive)) {
    throw new Error(`${name} must be > ${minExclusive}, got ${value}`);
  }
  if (min !== undefined && value < min) {
    throw new Error(`${name} must be >= ${min}, got ${value}`);
  }
  if (max !== undefined && value > max) {
    throw new Error(`${name} must be <= ${max}, got ${value}`);
  }
  return value;
}

/**
 * Parse an integer env var.
 *
 * @param {string|undefined|null} raw
 * @param {{name: string, def: number, min?: number, max?: number}} opts
 * @returns {number}
 */
export function parseIntegerEnv(raw, { name, def, min, max }) {
  const trimmed = trimmedOrNull(raw);
  if (trimmed === null) return def;
  if (!INTEGER_RE.test(trimmed)) {
    throw new Error(`${name} must be an integer, got ${JSON.stringify(String(raw))}`);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be an integer, got ${JSON.stringify(String(raw))}`);
  }
  return assertInRange(value, { name, min, max });
}

/**
 * Parse a floating-point env var.
 *
 * @param {string|undefined|null} raw
 * @param {{name: string, def: number, min?: number, minExclusive?: number, max?: number}} opts
 * @returns {number}
 */
export function parseFloatEnv(raw, { name, def, min, minExclusive, max }) {
  const trimmed = trimmedOrNull(raw);
  if (trimmed === null) return def;
  const value = FLOAT_RE.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number, got ${JSON.stringify(String(raw))}`);
  }
  return assertInRange(value, { name, min, minExclusive, max });
}

/**
 * Parse a boolean env var. Only the documented spellings are accepted — an
 * unrecognised one throws rather than being guessed into `false`.
 *
 * @param {string|undefined|null} raw
 * @param {{name: string, def: boolean}} opts
 * @returns {boolean}
 */
export function parseBooleanEnv(raw, { name, def }) {
  const trimmed = trimmedOrNull(raw);
  if (trimmed === null) return def;
  const lowered = trimmed.toLowerCase();
  if (TRUTHY.has(lowered)) return true;
  if (FALSY.has(lowered)) return false;
  throw new Error(
    `${name} must be a boolean (true/false/1/0/yes/no/on/off), got ${JSON.stringify(String(raw))}`,
  );
}

/**
 * Parse a string env var (a path, a bind host, …). Trimmed; blank means unset.
 *
 * @param {string|undefined|null} raw
 * @param {{name: string, def: string}} opts
 * @returns {string}
 */
export function parseStringEnv(raw, { name: _name, def }) {
  const trimmed = trimmedOrNull(raw);
  return trimmed === null ? def : trimmed;
}

/**
 * Every port this process may bind, in the order collisions are reported.
 *
 * Two writers sharing a lock port is a silent failure: the second one refuses to start
 * and that venue is simply never collected, with no error anywhere. Cheap to check here,
 * expensive to discover later.
 */
function assertPortsDistinct(entries) {
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      if (entries[i].value === entries[j].value) {
        throw new Error(
          `${entries[i].name} and ${entries[j].name} must differ (both ${entries[i].value})`,
        );
      }
    }
  }
}

/**
 * Build the frozen runtime configuration from an environment.
 *
 * @param {Record<string, string|undefined>} [env] defaults to `process.env`
 * @returns {Readonly<object>} deeply frozen
 * @throws {Error} on the first invalid or conflicting knob, naming it
 */
export function loadConfig(env = process.env) {
  const port = parseIntegerEnv(env.GPA_PORT, {
    name: 'GPA_PORT',
    def: DEFAULTS.GPA_PORT,
    min: MIN_PORT,
    max: MAX_PORT,
  });

  const lockPortSpecs = [
    ['polymarket', 'GPA_LOCK_PORT_POLYMARKET'],
    ['kalshi', 'GPA_LOCK_PORT_KALSHI'],
    ['limitless', 'GPA_LOCK_PORT_LIMITLESS'],
    // The watchdog owns the retention sweep, so it is a writer too and needs its own lock.
    ['watchdog', 'GPA_LOCK_PORT_WATCHDOG'],
  ];

  const lockPorts = {};
  for (const [key, name] of lockPortSpecs) {
    lockPorts[key] = parseIntegerEnv(env[name], {
      name,
      def: DEFAULTS[name],
      min: MIN_PORT,
      max: MAX_PORT,
    });
  }

  assertPortsDistinct([
    { name: 'GPA_PORT', value: port },
    ...lockPortSpecs.map(([key, name]) => ({ name, value: lockPorts[key] })),
  ]);

  const missSampleMs = parseIntegerEnv(env.GPA_MISS_SAMPLE_MS, {
    name: 'GPA_MISS_SAMPLE_MS',
    def: DEFAULTS.GPA_MISS_SAMPLE_MS,
    min: 0,
  });

  const feedStaleMs = {};
  for (const [key, name] of [
    ['polymarket', 'GPA_FEED_STALE_MS_POLYMARKET'],
    ['kalshi', 'GPA_FEED_STALE_MS_KALSHI'],
    ['limitless', 'GPA_FEED_STALE_MS_LIMITLESS'],
  ]) {
    feedStaleMs[key] = parseIntegerEnv(env[name], { name, def: DEFAULTS[name], min: 1 });
  }

  // These two knobs are coupled, and the coupling is invisible from either one alone: a
  // healthy but quiet feed writes nothing for one whole sampling period by design, so a
  // staleness threshold at or below that period alerts on normal operation. Caught here
  // rather than at 3am.
  assertThresholdsExceedSampling(feedStaleMs, missSampleMs);

  return Object.freeze({
    /** SQLite file path. */
    db: parseStringEnv(env.GPA_DB, { name: 'GPA_DB', def: DEFAULTS.GPA_DB }),

    /**
     * Freshness gate: never act on a book image older than this. The dominant
     * live-vs-backtest gap for any taker arb is that a displayed crossing is
     * disproportionately one somebody is already taking or cancelling.
     */
    bookStaleMs: parseIntegerEnv(env.GPA_BOOK_STALE_MS, {
      name: 'GPA_BOOK_STALE_MS',
      def: DEFAULTS.GPA_BOOK_STALE_MS,
      min: 1,
      max: MAX_BOOK_STALE_MS,
    }),

    /** Minimum post-fee edge per complete set, as a price fraction. */
    minNetEdge: parseFloatEnv(env.GPA_MIN_NET_EDGE, {
      name: 'GPA_MIN_NET_EDGE',
      def: DEFAULTS.GPA_MIN_NET_EDGE,
      minExclusive: 0,
      max: 1,
    }),

    /** Hard cap on the notional committed to any one complete set. */
    maxSetSizeUsd: parseFloatEnv(env.GPA_MAX_SET_SIZE_USD, {
      name: 'GPA_MAX_SET_SIZE_USD',
      def: DEFAULTS.GPA_MAX_SET_SIZE_USD,
      minExclusive: 0,
    }),

    /**
     * Size to `min(depth across legs) × this`. Exactly 0 is rejected: it is not
     * "disabled", it silently sizes every trade to nothing.
     */
    depthSafetyFactor: parseFloatEnv(env.GPA_DEPTH_SAFETY_FACTOR, {
      name: 'GPA_DEPTH_SAFETY_FACTOR',
      def: DEFAULTS.GPA_DEPTH_SAFETY_FACTOR,
      minExclusive: 0,
      max: 1,
    }),

    /**
     * How often a NON-clearing set may be re-recorded, per event key.
     *
     * Clearing sets are always persisted. Misses are sampled, because without a bound
     * the scanner rewrites the same verdict thousands of times: a 54-second live run
     * wrote 635,516 rows across 183 event keys (~3,470 each, 97% of them redundant
     * stale-book skips) and 346MB of database — about 550GB/day. The miss DISTRIBUTION
     * is what the measurement needs, and a sample gives that; every individual
     * re-evaluation does not.
     */
    missSampleMs,

    /**
     * How often the scanner rebuilds its market universe.
     *
     * Markets are created and resolved continuously, so discovering once at startup
     * measures a universe that only shrinks, and never sees a market created after boot.
     * Floored well above zero because each pass is a full paginated crawl.
     */
    rediscoverMs: parseIntegerEnv(env.GPA_REDISCOVER_MS, {
      name: 'GPA_REDISCOVER_MS',
      def: DEFAULTS.GPA_REDISCOVER_MS,
      min: 60000,
    }),

    /** `opportunities` retention in days; 0 disables the sweep. */
    keepOppDays: parseIntegerEnv(env.GPA_KEEP_OPP_DAYS, {
      name: 'GPA_KEEP_OPP_DAYS',
      def: DEFAULTS.GPA_KEEP_OPP_DAYS,
      min: 0,
    }),

    /**
     * SQLite `busy_timeout`. Exactly 0 IS valid here — SQLite's well-defined
     * "never wait, fail immediately on a lock conflict" mode. Deliberately a
     * different rule from `depthSafetyFactor` above; do not unify them.
     */
    dbBusyTimeoutMs: parseIntegerEnv(env.GPA_DB_BUSY_TIMEOUT_MS, {
      name: 'GPA_DB_BUSY_TIMEOUT_MS',
      def: DEFAULTS.GPA_DB_BUSY_TIMEOUT_MS,
      min: 0,
    }),

    /** Dashboard bind host — loopback by default; set explicitly to opt into LAN. */
    bind: parseStringEnv(env.GPA_BIND, { name: 'GPA_BIND', def: DEFAULTS.GPA_BIND }),

    /** Dashboard HTTP port. */
    port,

    /** Singleton-lock ports, one per scanner writer process. */
    lockPorts: Object.freeze(lockPorts),

    /** How often the watchdog checks every feed's clock. */
    watchdogIntervalMs: parseIntegerEnv(env.GPA_WATCHDOG_INTERVAL_MS, {
      name: 'GPA_WATCHDOG_INTERVAL_MS',
      def: DEFAULTS.GPA_WATCHDOG_INTERVAL_MS,
      min: 1000,
    }),

    /**
     * How long before a still-stale feed is re-reported. `0` re-reports on every check —
     * valid, and the fastest way to render the alert channel useless.
     */
    watchdogRepeatMs: parseIntegerEnv(env.GPA_WATCHDOG_REPEAT_MS, {
      name: 'GPA_WATCHDOG_REPEAT_MS',
      def: DEFAULTS.GPA_WATCHDOG_REPEAT_MS,
      min: 0,
    }),

    /** Per-venue feed staleness thresholds — never one global number; see lib/watchdog.mjs. */
    feedStaleMs: Object.freeze(feedStaleMs),
  });
}
