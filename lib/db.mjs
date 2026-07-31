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
