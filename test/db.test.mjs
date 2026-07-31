import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import { openDb, retentionCutoffMs } from '../lib/db.mjs';

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

test('openDb applies the schema, creating exactly the four expected tables', () => {
  const dir = scratch();
  try {
    const db = openDb(join(dir, 'a.db'));
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => r.name);
    assert.deepEqual(names, ['book_tops', 'markets', 'opportunities', 'opportunity_legs']);
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
  assert.deepEqual(names, ['book_tops', 'markets', 'opportunities', 'opportunity_legs']);
  db.close();
});
