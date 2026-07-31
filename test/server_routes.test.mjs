import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../lib/db.mjs';
import { WINDOWS, handleApi, resolveWindow } from '../lib/server_routes.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'gp-arb-routes-'));
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 6, 31, 12, 0, 0);

const CFG = Object.freeze({ minNetEdge: 0.005 });

function seed(db, o) {
  db.prepare(
    `INSERT INTO opportunities
       (venue, event_key, ts, kind, leg_count, gross_cost, total_fee, net_edge,
        capacity_shares, capacity_usd, binding_leg, book_age_ms, detected_ms, skip_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    o.venue ?? 'polymarket', o.eventKey, o.ts, o.kind ?? 'binary', 2,
    o.grossCost ?? null, o.totalFee ?? null, o.netEdge ?? null,
    null, o.capacityUsd ?? null, o.bindingLeg ?? null, null, null, o.skipReason ?? null,
  );
}

function withDb(fn) {
  const dir = scratch();
  const db = openDb(join(dir, 'a.db'));
  try {
    return fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const call = (db, path, query = '') =>
  handleApi(new URL(`http://x${path}${query}`), { db, cfg: CFG, nowMs: NOW });

// ── resolveWindow ───────────────────────────────────────────────────────────

test('resolveWindow maps each offered window to an absolute cutoff', () => {
  assert.deepEqual(resolveWindow('1h', NOW), { window: '1h', sinceMs: NOW - HOUR });
  assert.deepEqual(resolveWindow('24h', NOW), { window: '24h', sinceMs: NOW - 24 * HOUR });
  assert.deepEqual(resolveWindow('7d', NOW), { window: '7d', sinceMs: NOW - 168 * HOUR });
});

test('resolveWindow treats "all" as unbounded, not as a very large number', () => {
  assert.deepEqual(resolveWindow('all', NOW), { window: 'all', sinceMs: undefined });
});

test('resolveWindow falls back to the default instead of throwing on junk', () => {
  // A mistyped query string should not blank the dashboard — but the label returned is
  // the one actually used, so the number on screen always matches its heading.
  for (const junk of ['', null, undefined, 'forever', '../etc', 'constructor', '__proto__']) {
    const r = resolveWindow(junk, NOW);
    assert.equal(r.window, '24h', String(junk));
    assert.equal(r.sinceMs, NOW - 24 * HOUR);
  }
});

test('WINDOWS is frozen and every entry is a non-negative hour count', () => {
  assert.equal(Object.isFrozen(WINDOWS), true);
  for (const [key, hours] of Object.entries(WINDOWS)) {
    assert.ok(Number.isFinite(hours) && hours >= 0, key);
  }
});

// ── routing ─────────────────────────────────────────────────────────────────

test('an unknown endpoint is a 404 naming the path, not a 500', () => {
  withDb((db) => {
    const res = call(db, '/api/nope');
    assert.equal(res.status, 404);
    assert.match(res.body.error, /no such endpoint/);
  });
});

test('/api/summary reports the window it actually used and the floor it applied', () => {
  withDb((db) => {
    seed(db, { eventKey: 'a', ts: NOW - 1000, netEdge: 0.02, capacityUsd: 100 });
    seed(db, { eventKey: 'b', ts: NOW - 2000, netEdge: -0.2 });
    seed(db, { eventKey: 'c', ts: NOW - 3000, skipReason: 'stale_book' });

    const { status, body } = call(db, '/api/summary', '?window=1h');
    assert.equal(status, 200);
    assert.equal(body.window, '1h');
    assert.equal(body.minNetEdge, 0.005);
    assert.equal(body.generatedAtMs, NOW);
    assert.equal(body.total, 3);
    assert.equal(body.priced, 2);
    assert.equal(body.clears, 1);
  });
});

test('the window genuinely excludes older rows', () => {
  withDb((db) => {
    seed(db, { eventKey: 'recent', ts: NOW - 1000, netEdge: 0.02 });
    seed(db, { eventKey: 'old', ts: NOW - 5 * HOUR, netEdge: 0.02 });
    assert.equal(call(db, '/api/summary', '?window=1h').body.total, 1);
    assert.equal(call(db, '/api/summary', '?window=24h').body.total, 2);
    assert.equal(call(db, '/api/summary', '?window=all').body.total, 2);
    assert.equal(call(db, '/api/summary', '?window=all').body.sinceMs, null);
  });
});

test('the venue filter is honoured across endpoints', () => {
  withDb((db) => {
    seed(db, { eventKey: 'p', ts: NOW - 1000, netEdge: 0.02 });
    seed(db, { eventKey: 'k', ts: NOW - 1000, netEdge: 0.02, venue: 'kalshi' });
    assert.equal(call(db, '/api/summary', '?venue=polymarket').body.total, 1);
    assert.equal(call(db, '/api/summary').body.total, 2, 'no filter means every venue');
  });
});

test('/api/edge-distribution returns every bucket, including empty ones', () => {
  withDb((db) => {
    seed(db, { eventKey: 'a', ts: NOW - 1000, netEdge: -0.02 });
    const { body } = call(db, '/api/edge-distribution');
    assert.equal(body.buckets.length, 6);
    assert.equal(body.buckets.reduce((n, b) => n + b.count, 0), 1);
  });
});

test('/api/density, /api/categories and /api/capacity answer on an empty database', () => {
  // The dashboard is opened before any data exists; every panel must render rather than
  // erroring, or the first thing an operator sees is a broken page.
  withDb((db) => {
    assert.deepEqual(call(db, '/api/density').body.hours, []);
    assert.deepEqual(call(db, '/api/categories').body.categories, []);
    const cap = call(db, '/api/capacity').body;
    assert.equal(cap.book, 0);
    assert.equal(cap.notional, 0);
    assert.equal(cap.medianCapacityUsd, null);
    assert.deepEqual(call(db, '/api/recent-clears').body.clears, []);
    const s = call(db, '/api/summary').body;
    assert.equal(s.total, 0);
    assert.equal(s.bestNetEdge, null);
  });
});

test('/api/capacity separates a thin book from a bound notional cap', () => {
  withDb((db) => {
    seed(db, { eventKey: 'a', ts: NOW - 1000, netEdge: 0.02, bindingLeg: '0', capacityUsd: 10 });
    seed(db, { eventKey: 'b', ts: NOW - 1000, netEdge: 0.02, bindingLeg: 'notional', capacityUsd: 250 });
    const body = call(db, '/api/capacity').body;
    assert.equal(body.book, 1);
    assert.equal(body.notional, 1);
  });
});

test('/api/recent-clears returns only clearing sets, newest first', () => {
  withDb((db) => {
    seed(db, { eventKey: 'old', ts: NOW - 3000, netEdge: 0.02 });
    seed(db, { eventKey: 'new', ts: NOW - 1000, netEdge: 0.03 });
    seed(db, { eventKey: 'miss', ts: NOW - 500, netEdge: 0.001 });
    const { clears } = call(db, '/api/recent-clears').body;
    assert.deepEqual(clears.map((c) => c.eventKey), ['new', 'old']);
  });
});

test('/api/recent-clears survives a mistyped limit rather than 500ing the panel', () => {
  withDb((db) => {
    seed(db, { eventKey: 'a', ts: NOW - 1000, netEdge: 0.02 });
    assert.equal(call(db, '/api/recent-clears', '?limit=lots').status, 200);
    assert.equal(call(db, '/api/recent-clears', '?limit=1').body.clears.length, 1);
    assert.equal(call(db, '/api/recent-clears', '?limit=-5').body.clears.length, 1, 'floored');
  });
});
