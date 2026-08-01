import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import {
  getState,
  openDb,
  persistMarkets,
  retentionCutoffMs,
  setState,
  sweepOpportunities,
} from '../lib/db.mjs';

/** Build a scratch directory. Helpers build INPUTS, never expected outputs. */
function scratch() {
  return mkdtempSync(join(tmpdir(), 'gp-arb-bot-test-'));
}

const DAY_MS = 86_400_000;

// ── retentionCutoffMs ───────────────────────────────────────────────────────

test('retentionCutoffMs subtracts keepDays worth of milliseconds', () => {
  // 90 days = 90 * 86_400_000 = 7_776_000_000 ms
  assert.equal(retentionCutoffMs(1_000_000_000_000, 90), 992_224_000_000);
  // 1 day
  assert.equal(retentionCutoffMs(1_000_000_000_000, 1), 999_913_600_000);
  // 7 days = 604_800_000 ms
  assert.equal(retentionCutoffMs(1_000_000_000_000, 7), 999_395_200_000);
});

test('retentionCutoffMs returns null when retention is disabled with 0', () => {
  assert.equal(retentionCutoffMs(1_000_000_000_000, 0), null);
  assert.equal(retentionCutoffMs(0, 0), null);
});

test('retentionCutoffMs may return a negative cutoff rather than clamping', () => {
  // A clock earlier than the retention window is a caller problem, not something to
  // paper over by silently clamping to 0 — that would delete nothing and look fine.
  assert.equal(retentionCutoffMs(DAY_MS, 2), -DAY_MS);
});

test('retentionCutoffMs rejects a non-integer or negative keepDays', () => {
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '90', null, undefined]) {
    assert.throws(
      () => retentionCutoffMs(1_000_000_000_000, bad),
      /keepDays must be a non-negative integer/,
      `expected keepDays ${String(bad)} to be rejected`,
    );
  }
});

test('retentionCutoffMs rejects a non-finite nowMs', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '123', null, undefined]) {
    assert.throws(
      () => retentionCutoffMs(bad, 90),
      /nowMs must be a finite number/,
      `expected nowMs ${String(bad)} to be rejected`,
    );
  }
});

// ── openDb: validation ──────────────────────────────────────────────────────

test('openDb rejects a busyTimeoutMs that is negative, fractional or non-finite', () => {
  const dir = scratch();
  try {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5000', null]) {
      assert.throws(
        () => openDb(join(dir, 'a.db'), { busyTimeoutMs: bad }),
        /busyTimeoutMs must be a non-negative integer/,
        `expected busyTimeoutMs ${String(bad)} to be rejected`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openDb accepts busyTimeoutMs of exactly 0 — SQLite fail-immediately mode', () => {
  const dir = scratch();
  try {
    const db = openDb(join(dir, 'a.db'), { busyTimeoutMs: 0 });
    assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 0);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openDb rejects a file path that is not a non-empty string', () => {
  for (const bad of ['', '   ', null, undefined, 42]) {
    assert.throws(
      () => openDb(bad),
      /file must be a non-empty string/,
      `expected file ${String(bad)} to be rejected`,
    );
  }
});

// ── openDb: writable handle ─────────────────────────────────────────────────

test('openDb creates the parent directory when it does not exist', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'nested', 'deeper', 'arb.db');
    assert.equal(existsSync(join(dir, 'nested')), false);
    const db = openDb(path);
    assert.equal(existsSync(path), true);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openDb sets WAL journal mode and the requested busy_timeout', () => {
  const dir = scratch();
  try {
    const db = openDb(join(dir, 'a.db'), { busyTimeoutMs: 1234 });
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 1234);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openDb defaults busy_timeout to 5000 when not specified', () => {
  const dir = scratch();
  try {
    const db = openDb(join(dir, 'a.db'));
    assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openDb applies the schema, creating exactly the five expected tables', () => {
  const dir = scratch();
  try {
    const db = openDb(join(dir, 'a.db'));
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => r.name);
    assert.deepEqual(names, ['book_tops', 'markets', 'opportunities', 'opportunity_legs', 'service_state']);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openDb is idempotent — reopening an existing DB preserves its rows', () => {
  const dir = scratch();
  const path = join(dir, 'a.db');
  try {
    const first = openDb(path);
    first
      .prepare(
        'INSERT INTO markets (venue, event_key, condition_id, token_id, outcome, first_seen, last_seen)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run('polymarket', 'evt-1', 'cond-1', 'tok-1', 'YES', 1000, 1000);
    first.close();

    const second = openDb(path);
    assert.equal(second.prepare('SELECT COUNT(*) AS n FROM markets').get().n, 1);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the schema enforces the opportunity_legs foreign key', () => {
  const dir = scratch();
  try {
    const db = openDb(join(dir, 'a.db'));
    assert.throws(
      () =>
        db
          .prepare(
            'INSERT INTO opportunity_legs (opportunity_id, token_id, outcome, price, size_shares, fee_usd)' +
              ' VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(999, 'tok-1', 'YES', 0.4, 10, 0.01),
      /FOREIGN KEY constraint failed/,
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a market is unique per (venue, token_id)', () => {
  const dir = scratch();
  try {
    const db = openDb(join(dir, 'a.db'));
    const insert = db.prepare(
      'INSERT INTO markets (venue, event_key, condition_id, token_id, outcome, first_seen, last_seen)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    insert.run('polymarket', 'evt-1', 'cond-1', 'tok-1', 'YES', 1000, 1000);
    // same token on a different venue is a different row
    insert.run('kalshi', 'evt-1', 'cond-1', 'tok-1', 'YES', 1000, 1000);
    assert.throws(
      () => insert.run('polymarket', 'evt-1', 'cond-1', 'tok-1', 'YES', 2000, 2000),
      /UNIQUE constraint failed/,
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── openDb: read-only handle ────────────────────────────────────────────────

test('a read-only handle can read but not write', () => {
  const dir = scratch();
  const path = join(dir, 'a.db');
  try {
    const writer = openDb(path);
    writer
      .prepare(
        'INSERT INTO markets (venue, event_key, condition_id, token_id, outcome, first_seen, last_seen)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run('polymarket', 'evt-1', 'cond-1', 'tok-1', 'YES', 1000, 1000);
    writer.close();

    const reader = openDb(path, { readOnly: true });
    assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM markets').get().n, 1);
    assert.throws(() => reader.exec('CREATE TABLE z (a INTEGER)'));
    reader.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a read-only handle does not create the parent directory or the file', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'absent', 'a.db');
    assert.throws(() => openDb(path, { readOnly: true }));
    assert.equal(existsSync(join(dir, 'absent')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── openDb: failure after the handle is already open ────────────────────────

/**
 * Poison a DB so that applying the schema fails AFTER the handle is open.
 *
 * A table occupying an index's name is a realistic "pre-existing DB of a different
 * shape" case, and unlike a column mismatch it genuinely throws — `CREATE TABLE
 * IF NOT EXISTS` is a no-op against a differently-shaped table, but
 * `CREATE INDEX IF NOT EXISTS` against an existing TABLE of that name is an error.
 * Helper builds an INPUT (a poisoned file), never an expected output.
 */
function poisonedDbPath(dir) {
  const path = join(dir, 'poisoned.db');
  const db = openDb(path);
  db.close();
  const raw = new DatabaseSync(path);
  raw.exec('DROP INDEX idx_markets_event');
  raw.exec('CREATE TABLE idx_markets_event (x INTEGER)');
  raw.close();
  return path;
}

test('openDb propagates a post-open failure instead of swallowing it', () => {
  const dir = scratch();
  try {
    assert.throws(
      () => openDb(poisonedDbPath(dir)),
      /there is already a table named idx_markets_event/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openDb CLOSES the handle when configuration fails after opening it', () => {
  const dir = scratch();
  try {
    const path = poisonedDbPath(dir);
    // Hold a reference from outside: openDb throws, so the caller never receives the
    // handle and could not otherwise observe whether it was released. A leak here
    // compounds, because a scanner under a supervision loop retries openDb.
    let handle = null;
    assert.throws(() =>
      openDb(path, {
        open: (f, options) => {
          handle = new DatabaseSync(f, options);
          return handle;
        },
      }),
    );
    assert.notEqual(handle, null, 'the injected opener should have been called');
    assert.equal(handle.isOpen, false, 'the handle must be closed before the error escapes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openDb returns an OPEN handle on the success path', () => {
  const dir = scratch();
  try {
    const db = openDb(join(dir, 'ok.db'));
    assert.equal(db.isOpen, true);
    db.close();
    assert.equal(db.isOpen, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openDb enables foreign key enforcement explicitly on both handle kinds', () => {
  const dir = scratch();
  const path = join(dir, 'a.db');
  try {
    const writer = openDb(path);
    assert.equal(writer.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    writer.close();

    const reader = openDb(path, { readOnly: true });
    assert.equal(reader.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    reader.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an in-memory DB opens with the schema applied and needs no directory', () => {
  const db = openDb(':memory:');
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.deepEqual(names, ['book_tops', 'markets', 'opportunities', 'opportunity_legs', 'service_state']);
  db.close();
});


// ── persistMarkets ──────────────────────────────────────────────────────────

const marketRow = (over = {}) => ({
  venue: 'polymarket',
  eventKey: 'evt-1',
  conditionId: 'cond-1',
  tokenId: 'tok-1',
  outcome: 'Yes',
  marketSlug: 'a-slug',
  category: 'politics',
  feeRate: 0.04,
  tickSize: 0.01,
  minOrderSize: 5,
  negRisk: false,
  ...over,
});

test('persistMarkets writes discovered markets', () => {
  const dir = scratch();
  try {
    const db = openDb(join(dir, 'a.db'));
    const written = persistMarkets(db, [marketRow(), marketRow({ tokenId: 'tok-2', outcome: 'No' })], 1000);
    assert.equal(written, 2);
    const row = db.prepare('SELECT * FROM markets WHERE token_id = ?').get('tok-1');
    assert.equal(row.category, 'politics');
    assert.equal(row.fee_rate, 0.04);
    assert.equal(row.neg_risk, 0);
    assert.equal(row.first_seen, 1000);
    assert.equal(row.last_seen, 1000);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistMarkets advances last_seen but PRESERVES first_seen', () => {
  // A market's age is recoverable only if the first sighting survives re-discovery.
  const dir = scratch();
  try {
    const db = openDb(join(dir, 'a.db'));
    persistMarkets(db, [marketRow()], 1000);
    persistMarkets(db, [marketRow({ category: 'crypto', feeRate: 0.07 })], 5000);
    const row = db.prepare('SELECT * FROM markets WHERE token_id = ?').get('tok-1');
    assert.equal(row.first_seen, 1000, 'preserved');
    assert.equal(row.last_seen, 5000, 'advanced');
    assert.equal(row.category, 'crypto', 'mutable metadata is refreshed');
    assert.equal(row.fee_rate, 0.07);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM markets').get().n, 1, 'no duplicate row');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistMarkets treats the same token on another venue as a separate market', () => {
  const dir = scratch();
  try {
    const db = openDb(join(dir, 'a.db'));
    persistMarkets(db, [marketRow(), marketRow({ venue: 'kalshi' })], 1000);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM markets').get().n, 2);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistMarkets is atomic — a bad row writes none of the batch', () => {
  const dir = scratch();
  try {
    const db = openDb(join(dir, 'a.db'));
    assert.throws(() =>
      persistMarkets(db, [marketRow(), marketRow({ tokenId: 'tok-2', venue: {} })], 1000),
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM markets').get().n, 0);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistMarkets stores nulls for absent optional metadata', () => {
  // An unmapped market still belongs in the table: dropping it would make the
  // uncategorised share invisible, which is itself a number worth watching.
  const dir = scratch();
  try {
    const db = openDb(join(dir, 'a.db'));
    persistMarkets(
      db,
      [{ venue: 'polymarket', eventKey: 'e', conditionId: 'c', tokenId: 't', outcome: 'Yes' }],
      1000,
    );
    const row = db.prepare('SELECT * FROM markets WHERE token_id = ?').get('t');
    assert.equal(row.market_slug, null);
    assert.equal(row.category, null);
    assert.equal(row.fee_rate, null);
    assert.equal(row.tick_size, null);
    assert.equal(row.min_order_size, null);
    assert.equal(row.neg_risk, 0, 'absent negRisk is false, not null');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistMarkets records a neg-risk member with the flag set', () => {
  const dir = scratch();
  try {
    const db = openDb(join(dir, 'a.db'));
    persistMarkets(db, [marketRow({ negRisk: true })], 1000);
    assert.equal(db.prepare('SELECT neg_risk n FROM markets').get().n, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistMarkets writes nothing for an empty batch', () => {
  const dir = scratch();
  try {
    const db = openDb(join(dir, 'a.db'));
    assert.equal(persistMarkets(db, [], 1000), 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM markets').get().n, 0);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistMarkets rejects an unusable timestamp', () => {
  const dir = scratch();
  try {
    const db = openDb(join(dir, 'a.db'));
    for (const bad of [Number.NaN, '1000', null, undefined]) {
      assert.throws(() => persistMarkets(db, [marketRow()], bad), /nowMs must be a finite number/);
    }
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── sweepOpportunities ──────────────────────────────────────────────────────

const SWEEP_NOW = Date.UTC(2026, 6, 31, 12, 0, 0);
const SWEEP_DAY = 86_400_000;

function seedOpp(db, ts, { legs = 2 } = {}) {
  const res = db
    .prepare(
      `INSERT INTO opportunities (venue, event_key, ts, kind, leg_count)
       VALUES ('polymarket', ?, ?, 'binary', ?)`,
    )
    .run(`e-${ts}`, ts, legs);
  const id = Number(res.lastInsertRowid);
  for (let i = 0; i < legs; i += 1) {
    db.prepare(
      `INSERT INTO opportunity_legs (opportunity_id, token_id, outcome, price)
       VALUES (?, ?, ?, ?)`,
    ).run(id, `t-${ts}-${i}`, i === 0 ? 'Yes' : 'No', 0.5);
  }
  return id;
}

function withSweepDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gp-arb-sweep-'));
  const db = openDb(join(dir, 'a.db'));
  try {
    return fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('sweepOpportunities deletes rows past the retention window and keeps the rest', () => {
  withSweepDb((db) => {
    seedOpp(db, SWEEP_NOW - 100 * SWEEP_DAY);
    seedOpp(db, SWEEP_NOW - 91 * SWEEP_DAY);
    seedOpp(db, SWEEP_NOW - 89 * SWEEP_DAY);
    seedOpp(db, SWEEP_NOW - SWEEP_DAY);

    const res = sweepOpportunities(db, { nowMs: SWEEP_NOW, keepDays: 90 });
    assert.equal(res.deleted, 2);
    assert.equal(res.cutoffMs, SWEEP_NOW - 90 * SWEEP_DAY);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM opportunities').get().n, 2);
  });
});

test('sweeping a row takes its legs with it, leaving no orphans', () => {
  // The cascade is armed by PRAGMA foreign_keys in openDb. If that pragma were ever
  // dropped the legs would survive their parent silently, and the table would grow
  // without bound while `opportunities` looked correctly trimmed.
  withSweepDb((db) => {
    seedOpp(db, SWEEP_NOW - 100 * SWEEP_DAY, { legs: 3 });
    seedOpp(db, SWEEP_NOW - SWEEP_DAY, { legs: 2 });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM opportunity_legs').get().n, 5);

    sweepOpportunities(db, { nowMs: SWEEP_NOW, keepDays: 90 });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM opportunity_legs').get().n, 2);
    assert.equal(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM opportunity_legs l
            WHERE NOT EXISTS (SELECT 1 FROM opportunities o WHERE o.id = l.opportunity_id)`,
        )
        .get().n,
      0,
    );
  });
});

test('keepDays 0 disables the sweep instead of deleting everything', () => {
  // The dangerous misreading: "keep zero days" as "delete all history". 0 means OFF, and
  // a sweep that wiped the dataset on a mistyped knob would destroy the week of evidence
  // the Phase 2 decision rests on.
  withSweepDb((db) => {
    seedOpp(db, SWEEP_NOW - 1000 * SWEEP_DAY);
    const res = sweepOpportunities(db, { nowMs: SWEEP_NOW, keepDays: 0 });
    assert.deepEqual(res, { deleted: 0, cutoffMs: null });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM opportunities').get().n, 1);
  });
});

test('a sweep with nothing to delete reports zero rather than failing', () => {
  withSweepDb((db) => {
    seedOpp(db, SWEEP_NOW - SWEEP_DAY);
    assert.equal(sweepOpportunities(db, { nowMs: SWEEP_NOW, keepDays: 90 }).deleted, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM opportunities').get().n, 1);
  });
});

test('a row exactly on the cutoff is kept — the boundary is strictly older-than', () => {
  withSweepDb((db) => {
    seedOpp(db, SWEEP_NOW - 90 * SWEEP_DAY);
    assert.equal(sweepOpportunities(db, { nowMs: SWEEP_NOW, keepDays: 90 }).deleted, 0);
  });
});

test('sweepOpportunities rejects a bad retention setting rather than sweeping wrongly', () => {
  withSweepDb((db) => {
    assert.throws(() => sweepOpportunities(db, { nowMs: SWEEP_NOW, keepDays: -1 }), TypeError);
    assert.throws(() => sweepOpportunities(db, { nowMs: SWEEP_NOW, keepDays: 1.5 }), TypeError);
    assert.throws(() => sweepOpportunities(db, { nowMs: Number.NaN, keepDays: 90 }), TypeError);
  });
});

// ── service_state: facts that must survive the process ─────────────────────

test('a key that was never written reads as null, not as a default', () => {
  // The startup throttle asks "have I announced recently?". A missing key must mean
  // "never", not "just now" -- the wrong answer here silences a first run entirely.
  withSweepDb((db) => assert.equal(getState(db, 'nope'), null));
});

test('setState then getState round-trips the value and its timestamp', () => {
  withSweepDb((db) => {
    setState(db, 'k', 'v', SWEEP_NOW);
    assert.deepEqual(getState(db, 'k'), { value: 'v', updatedMs: SWEEP_NOW });
  });
});

test('writing the same key again replaces it rather than erroring or duplicating', () => {
  withSweepDb((db) => {
    setState(db, 'k', 'first', SWEEP_NOW);
    setState(db, 'k', 'second', SWEEP_NOW + 1000);
    assert.deepEqual(getState(db, 'k'), { value: 'second', updatedMs: SWEEP_NOW + 1000 });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM service_state').get().n, 1);
  });
});

test('keys are independent', () => {
  withSweepDb((db) => {
    setState(db, 'a', '1', SWEEP_NOW);
    setState(db, 'b', '2', SWEEP_NOW);
    assert.equal(getState(db, 'a').value, '1');
    assert.equal(getState(db, 'b').value, '2');
  });
});

test('a value is stored as text, so a number round-trips as its string', () => {
  withSweepDb((db) => {
    setState(db, 'ts', 1700000000000, SWEEP_NOW);
    assert.equal(getState(db, 'ts').value, '1700000000000');
    assert.equal(Number(getState(db, 'ts').value), 1700000000000);
  });
});

test('setState rejects a non-finite timestamp rather than storing a corrupt one', () => {
  withSweepDb((db) => {
    assert.throws(() => setState(db, 'k', 'v', Number.NaN), TypeError);
    assert.throws(() => setState(db, 'k', 'v', undefined), TypeError);
  });
});

test('service_state survives reopening the database', () => {
  // The whole point: launchd kills and restarts the process, and this has to outlive it.
  const dir = mkdtempSync(join(tmpdir(), 'gp-arb-state-'));
  const file = join(dir, 'a.db');
  try {
    const first = openDb(file);
    setState(first, 'watchdog:last', '123', SWEEP_NOW);
    first.close();

    const second = openDb(file);
    assert.deepEqual(getState(second, 'watchdog:last'), { value: '123', updatedMs: SWEEP_NOW });
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
