/**
 * SQLite persistence, zero dependencies (`node:sqlite`).
 *
 * One database file for every venue, WAL journalling so a scanner writing and the
 * dashboard reading do not block each other.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** Absolute path to this repo's `schema.sql`. */
export const SCHEMA_PATH = join(MODULE_DIR, '..', 'schema.sql');

const DAY_MS = 86_400_000;

/** SQLite's own name for a database that lives entirely in RAM. */
const IN_MEMORY = ':memory:';

/**
 * The `ts` below which rows are older than the retention window.
 *
 * @param {number} nowMs current wall-clock time in ms
 * @param {number} keepDays days of history to keep; `0` disables retention entirely
 * @returns {number|null} the cutoff, or `null` when retention is disabled
 * @throws {TypeError} on a non-finite `nowMs` or a non-integer/negative `keepDays`
 */
export function retentionCutoffMs(nowMs, keepDays) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new TypeError(`nowMs must be a finite number, got ${String(nowMs)}`);
  }
  if (typeof keepDays !== 'number' || !Number.isInteger(keepDays) || keepDays < 0) {
    throw new TypeError(`keepDays must be a non-negative integer, got ${String(keepDays)}`);
  }
  if (keepDays === 0) return null;
  // Deliberately NOT clamped at 0: a cutoff in the past is a caller/clock problem, and
  // clamping would silently turn "delete nothing" into a healthy-looking no-op.
  return nowMs - keepDays * DAY_MS;
}

/** Default handle factory. Split out only so `openDb`'s cleanup path is observable. */
function defaultOpen(file, options) {
  return new DatabaseSync(file, options);
}

/**
 * Open the database, applying `schema.sql` on a writable handle.
 *
 * @param {string} file path, or `':memory:'`
 * @param {{readOnly?: boolean, busyTimeoutMs?: number, open?: Function}} [opts]
 *   `open` is a seam for tests: `DatabaseSync` gives no way to inspect a handle that
 *   `openDb` threw before returning, so verifying the failure path actually closes it
 *   requires holding a reference from outside. Production callers never pass it.
 * @returns {import('node:sqlite').DatabaseSync}
 * @throws {TypeError} on an unusable `file` or `busyTimeoutMs`
 */
export function openDb(file, { readOnly = false, busyTimeoutMs = 5000, open = defaultOpen } = {}) {
  if (typeof file !== 'string' || file.trim() === '') {
    throw new TypeError(`file must be a non-empty string, got ${String(file)}`);
  }
  if (
    typeof busyTimeoutMs !== 'number' ||
    !Number.isInteger(busyTimeoutMs) ||
    busyTimeoutMs < 0
  ) {
    // 0 is explicitly allowed — SQLite's well-defined "never wait, fail immediately on a
    // lock conflict" mode. Do not copy this rule onto knobs where 0 is meaningless.
    throw new TypeError(
      `busyTimeoutMs must be a non-negative integer, got ${String(busyTimeoutMs)}`,
    );
  }

  const inMemory = file === IN_MEMORY;

  // Only a writer may create anything. A read-only open of a missing file must fail
  // loudly rather than quietly conjuring an empty directory beside it.
  if (!readOnly && !inMemory) {
    mkdirSync(dirname(file), { recursive: true });
  }

  const db = open(file, { readOnly });

  // Everything past the open can throw — a corrupt schema.sql, a DDL conflict against a
  // pre-existing DB of a different shape, a locked file. Without this, the handle and its
  // file descriptor leak on every failure, and a scanner under a supervision loop retries
  // openDb, so the leak compounds rather than staying a one-off.
  try {
    // Safe on either handle: both are per-connection state, not a file write.
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    // Set explicitly rather than inheriting node:sqlite's default, so the schema's
    // ON DELETE CASCADE keeps working even if that default ever changes. Without it a
    // retention sweep over `opportunities` would silently orphan `opportunity_legs`.
    db.exec('PRAGMA foreign_keys = ON');

    if (!readOnly) {
      // WAL is a file-format change; an in-memory DB has no WAL to switch to.
      if (!inMemory) db.exec('PRAGMA journal_mode = WAL');
      db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
    }
  } catch (err) {
    db.close();
    throw err;
  }

  return db;
}

/**
 * Upsert discovered markets, keyed by `(venue, token_id)`.
 *
 * Without this the `markets` table stays empty and every per-category readout collapses
 * to "(unknown)" — the fee-free bucket, which is the one place taker arbitrage still
 * works cleanly, becomes invisible exactly when it matters.
 *
 * `first_seen` is preserved on conflict while `last_seen` advances, so a market's age is
 * recoverable later; the mutable metadata (category, tick, minimum size) is refreshed
 * because the venue does re-tune it.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {ReadonlyArray<object>} rows normalized adapter rows
 * @param {number} nowMs
 * @returns {number} rows written
 */
export function persistMarkets(db, rows, nowMs) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new TypeError(`nowMs must be a finite number, got ${String(nowMs)}`);
  }
  const stmt = db.prepare(
    `INSERT INTO markets
       (venue, event_key, condition_id, token_id, outcome, market_slug, category,
        fee_rate, tick_size, min_order_size, neg_risk, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (venue, token_id) DO UPDATE SET
       event_key      = excluded.event_key,
       condition_id   = excluded.condition_id,
       outcome        = excluded.outcome,
       market_slug    = excluded.market_slug,
       category       = excluded.category,
       fee_rate       = excluded.fee_rate,
       tick_size      = excluded.tick_size,
       min_order_size = excluded.min_order_size,
       neg_risk       = excluded.neg_risk,
       last_seen      = excluded.last_seen`,
  );

  db.exec('BEGIN');
  try {
    let written = 0;
    for (const r of rows) {
      stmt.run(
        r.venue,
        r.eventKey,
        r.conditionId,
        r.tokenId,
        r.outcome,
        r.marketSlug ?? null,
        r.category ?? null,
        r.feeRate ?? null,
        r.tickSize ?? null,
        r.minOrderSize ?? null,
        r.negRisk ? 1 : 0,
        nowMs,
        nowMs,
      );
      written += 1;
    }
    db.exec('COMMIT');
    return written;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Read a persisted service fact, or `null` if it was never written.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} key
 * @returns {{value: string, updatedMs: number}|null}
 */
export function getState(db, key) {
  const row = db.prepare('SELECT value, updated_ms FROM service_state WHERE key = ?').get(key);
  return row === undefined ? null : { value: String(row.value), updatedMs: Number(row.updated_ms) };
}

/**
 * Write a persisted service fact, replacing any previous value.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} key
 * @param {string} value
 * @param {number} nowMs
 */
export function setState(db, key, value, nowMs) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new TypeError(`nowMs must be a finite number, got ${String(nowMs)}`);
  }
  db.prepare(
    `INSERT INTO service_state (key, value, updated_ms) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_ms = excluded.updated_ms`,
  ).run(key, String(value), nowMs);
}

/**
 * Delete `opportunities` older than the retention window.
 *
 * Until this existed, `retentionCutoffMs` had no caller: `GPA_KEEP_OPP_DAYS` was
 * documented, validated and computed, and then nothing ever acted on it. A configured
 * retention that silently never runs is worse than no setting at all, because the
 * operator believes the growth is bounded and stops checking.
 *
 * `opportunity_legs` is not deleted here. The rows go with their parent via `ON DELETE
 * CASCADE`, which `openDb` arms with `PRAGMA foreign_keys = ON` — deleting them
 * separately would be a second place for the two tables to fall out of step.
 *
 * At the measured Polymarket write rate (~0.3 GB/day) the 90-day default is roughly 28GB.
 * The sweep is what keeps that a ceiling rather than a milestone.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{nowMs: number, keepDays: number}} args
 * @returns {{deleted: number, cutoffMs: number|null}} `cutoffMs` is null when disabled
 */
export function sweepOpportunities(db, { nowMs, keepDays }) {
  const cutoffMs = retentionCutoffMs(nowMs, keepDays);
  if (cutoffMs === null) return { deleted: 0, cutoffMs: null };

  // The row count comes from the DELETE itself. Counting first would scan the same rows
  // twice while holding the write lock, doubling the window in which a live scanner's
  // insert can block behind the sweep.
  const res = db.prepare('DELETE FROM opportunities WHERE ts < ?').run(cutoffMs);
  return { deleted: Number(res.changes), cutoffMs };
}
