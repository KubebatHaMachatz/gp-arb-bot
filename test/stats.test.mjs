import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../lib/db.mjs';
import {
  EDGE_BUCKETS,
  bucketForEdge,
  capacityBinding,
  categoryBreakdown,
  densityByHour,
  edgeDistribution,
  recentClears,
  summarize,
} from '../lib/stats.mjs';

const EPS = 1e-9;
const closeTo = (a, e, m) =>
  assert.ok(Math.abs(a - e) < EPS, `${m ?? 'value'}: expected ${e} +/- ${EPS}, got ${a}`);

const scratch = () => mkdtempSync(join(tmpdir(), 'gp-arb-stats-'));

const HOUR = 3_600_000;
/** A fixed epoch so every expectation is hand-computable. 2026-07-31T00:00:00Z. */
const T0 = Date.UTC(2026, 6, 31, 0, 0, 0);

/**
 * Seed one opportunity and its legs. Helpers build INPUTS only — every expected
 * aggregate below is computed by hand from these literals.
 */
function seedOpp(db, o) {
  const res = db
    .prepare(
      `INSERT INTO opportunities
         (venue, event_key, ts, kind, leg_count, gross_cost, total_fee, net_edge,
          capacity_shares, capacity_usd, binding_leg, book_age_ms, detected_ms, skip_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      o.venue ?? 'polymarket',
      o.eventKey,
      o.ts,
      o.kind ?? 'binary',
      o.legCount ?? 2,
      o.grossCost ?? null,
      o.totalFee ?? null,
      o.netEdge ?? null,
      o.capacityShares ?? null,
      o.capacityUsd ?? null,
      o.bindingLeg ?? null,
      o.bookAgeMs ?? null,
      o.detectedMs ?? null,
      o.skipReason ?? null,
    );
  const id = Number(res.lastInsertRowid);
  for (const l of o.legs ?? []) {
    db.prepare(
      `INSERT INTO opportunity_legs (opportunity_id, token_id, outcome, price, size_shares, fee_usd)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, l.tokenId, l.outcome ?? 'Yes', l.price ?? 0.5, l.sizeShares ?? 10, l.feeUsd ?? 0);
  }
  return id;
}

function seedMarket(db, m) {
  db.prepare(
    `INSERT INTO markets
       (venue, event_key, condition_id, token_id, outcome, market_slug, category,
        fee_rate, tick_size, min_order_size, neg_risk, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    m.venue ?? 'polymarket',
    m.eventKey ?? 'evt',
    m.conditionId ?? 'cond',
    m.tokenId,
    m.outcome ?? 'Yes',
    m.marketSlug ?? null,
    m.category ?? null,
    m.feeRate ?? null,
    m.tickSize ?? 0.01,
    m.minOrderSize ?? 5,
    m.negRisk ? 1 : 0,
    m.firstSeen ?? T0,
    m.lastSeen ?? T0,
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

// ── bucketForEdge ───────────────────────────────────────────────────────────

test('EDGE_BUCKETS are ordered, contiguous and centred on breakeven', () => {
  // Breakeven is the decision boundary, so the buckets have to resolve finely there
  // rather than lumping "just missed" together with "hopeless".
  assert.ok(EDGE_BUCKETS.length >= 5);
  assert.equal(Object.isFrozen(EDGE_BUCKETS), true);
  const labels = EDGE_BUCKETS.map((b) => b.label);
  assert.equal(new Set(labels).size, labels.length, 'labels are unique');
  // adjacent buckets must touch, leaving no edge unclassifiable
  for (let i = 1; i < EDGE_BUCKETS.length; i += 1) {
    assert.equal(EDGE_BUCKETS[i].min, EDGE_BUCKETS[i - 1].max, `gap before ${labels[i]}`);
  }
});

test('bucketForEdge places an edge in exactly one bucket', () => {
  // Hand-checked against the boundaries: [-Inf,-0.05) [-0.05,-0.01) [-0.01,0)
  //                                      [0,0.01) [0.01,0.05) [0.05,Inf)
  assert.equal(bucketForEdge(-1.42), '< -5c');
  assert.equal(bucketForEdge(-0.05), '-5c..-1c');
  assert.equal(bucketForEdge(-0.0101), '-5c..-1c');
  assert.equal(bucketForEdge(-0.01), '-1c..0');
  assert.equal(bucketForEdge(-0.001), '-1c..0');
  assert.equal(bucketForEdge(0), '0..+1c');
  assert.equal(bucketForEdge(0.009), '0..+1c');
  assert.equal(bucketForEdge(0.01), '+1c..+5c');
  assert.equal(bucketForEdge(0.05), '>= +5c');
  assert.equal(bucketForEdge(0.5), '>= +5c');
});

test('bucketForEdge rejects a non-finite edge rather than silently binning it', () => {
  for (const bad of [null, undefined, Number.NaN, '0.5', Number.POSITIVE_INFINITY]) {
    assert.throws(() => bucketForEdge(bad), /netEdge must be a finite number/, String(bad));
  }
});

test('a non-finite sinceMs is rejected rather than silently widening the window', () => {
  // Silently ignoring it would report the whole table under a label claiming "last hour".
  withDb((db) => {
    for (const bad of [Number.NaN, '1000', Number.POSITIVE_INFINITY, {}]) {
      assert.throws(
        () => summarize(db, { sinceMs: bad, minNetEdge: 0.005 }),
        /sinceMs must be a finite number/,
        String(bad),
      );
    }
    // null and undefined mean "unbounded", which is a legitimate request
    assert.doesNotThrow(() => summarize(db, { sinceMs: null, minNetEdge: 0.005 }));
    assert.doesNotThrow(() => summarize(db, { minNetEdge: 0.005 }));
  });
});

// ── summarize ───────────────────────────────────────────────────────────────

test('summarize counts priced, skipped and clearing sets over a window', () => {
  withDb((db) => {
    // 4 priced (2 of them clearing at the 0.005 floor), 2 freshness-skipped
    seedOpp(db, { eventKey: 'a', ts: T0 + 1, netEdge: 0.02, grossCost: 0.9, totalFee: 0.01, capacityUsd: 100 });
    seedOpp(db, { eventKey: 'b', ts: T0 + 2, netEdge: 0.006, grossCost: 0.9, totalFee: 0.01, capacityUsd: 50 });
    seedOpp(db, { eventKey: 'c', ts: T0 + 3, netEdge: 0.004, grossCost: 0.9, totalFee: 0.01, capacityUsd: 10 });
    seedOpp(db, { eventKey: 'd', ts: T0 + 4, netEdge: -0.3, grossCost: 1.2, totalFee: 0.02, capacityUsd: 10 });
    seedOpp(db, { eventKey: 'e', ts: T0 + 5, skipReason: 'stale_book', bookAgeMs: 900 });
    seedOpp(db, { eventKey: 'f', ts: T0 + 6, skipReason: 'stale_book', bookAgeMs: 1200 });

    const s = summarize(db, { minNetEdge: 0.005 });
    assert.equal(s.total, 6);
    assert.equal(s.priced, 4);
    assert.equal(s.skipped, 2);
    assert.equal(s.clears, 2, 'netEdge >= 0.005');
    // 2 skipped of 6 total
    closeTo(s.skipRate, 2 / 6, 'skipRate');
    // 2 clears of 4 priced — the rate that matters is over what was actually priceable
    closeTo(s.clearRate, 2 / 4, 'clearRate');
    closeTo(s.bestNetEdge, 0.02, 'bestNetEdge');
    // capacity is summed over CLEARING sets only: 100 + 50
    closeTo(s.clearingCapacityUsd, 150, 'clearingCapacityUsd');
  });
});

test('summarize reports zeroed rates on an empty window rather than NaN', () => {
  withDb((db) => {
    const s = summarize(db, { minNetEdge: 0.005 });
    assert.equal(s.total, 0);
    assert.equal(s.priced, 0);
    assert.equal(s.clears, 0);
    assert.equal(s.skipRate, 0);
    assert.equal(s.clearRate, 0);
    assert.equal(s.bestNetEdge, null, 'no best edge exists, and 0 would be a lie');
    assert.equal(s.clearingCapacityUsd, 0);
  });
});

test('summarize honours the since window and the venue filter', () => {
  withDb((db) => {
    seedOpp(db, { eventKey: 'old', ts: T0 - HOUR, netEdge: 0.9 });
    seedOpp(db, { eventKey: 'new', ts: T0 + 1, netEdge: 0.02 });
    seedOpp(db, { eventKey: 'other', ts: T0 + 2, netEdge: 0.02, venue: 'kalshi' });

    const windowed = summarize(db, { sinceMs: T0, minNetEdge: 0.005 });
    assert.equal(windowed.total, 2, 'the hour-old row is excluded');

    const scoped = summarize(db, { sinceMs: T0, venue: 'polymarket', minNetEdge: 0.005 });
    assert.equal(scoped.total, 1);
    closeTo(scoped.bestNetEdge, 0.02, 'bestNetEdge');
  });
});

test('summarize requires a usable minNetEdge — the floor decides what counts as a clear', () => {
  withDb((db) => {
    for (const bad of [0, -0.1, 1.5, Number.NaN, '0.005', undefined]) {
      assert.throws(
        () => summarize(db, { minNetEdge: bad }),
        /minNetEdge must be a finite number in \(0, 1\]/,
        String(bad),
      );
    }
  });
});

// ── edgeDistribution ────────────────────────────────────────────────────────

test('edgeDistribution bins priced sets and ignores skipped ones', () => {
  withDb((db) => {
    seedOpp(db, { eventKey: 'a', ts: T0 + 1, netEdge: -1.42 }); // < -5c
    seedOpp(db, { eventKey: 'b', ts: T0 + 2, netEdge: -0.03 }); // -5c..-1c
    seedOpp(db, { eventKey: 'c', ts: T0 + 3, netEdge: -0.004 }); // -1c..0
    seedOpp(db, { eventKey: 'd', ts: T0 + 4, netEdge: -0.002 }); // -1c..0
    seedOpp(db, { eventKey: 'e', ts: T0 + 5, netEdge: 0.02 }); // +1c..+5c
    seedOpp(db, { eventKey: 'f', ts: T0 + 6, skipReason: 'stale_book' });

    const dist = edgeDistribution(db, {});
    const byLabel = Object.fromEntries(dist.map((d) => [d.label, d.count]));
    assert.equal(byLabel['< -5c'], 1);
    assert.equal(byLabel['-5c..-1c'], 1);
    assert.equal(byLabel['-1c..0'], 2);
    assert.equal(byLabel['0..+1c'], 0, 'empty buckets are still reported');
    assert.equal(byLabel['+1c..+5c'], 1);
    assert.equal(byLabel['>= +5c'], 0);
    // every bucket appears exactly once, in declared order
    assert.deepEqual(dist.map((d) => d.label), EDGE_BUCKETS.map((b) => b.label));
    assert.equal(dist.reduce((n, d) => n + d.count, 0), 5, 'the skipped row is not binned');
  });
});

// ── densityByHour ───────────────────────────────────────────────────────────

test('densityByHour groups by UTC hour and separates clears from priced', () => {
  withDb((db) => {
    seedOpp(db, { eventKey: 'a', ts: T0 + 60_000, netEdge: 0.02 }); // hour 0, clears
    seedOpp(db, { eventKey: 'b', ts: T0 + 120_000, netEdge: -0.02 }); // hour 0, priced
    seedOpp(db, { eventKey: 'c', ts: T0 + 180_000, skipReason: 'stale_book' }); // hour 0, skipped
    seedOpp(db, { eventKey: 'd', ts: T0 + HOUR + 60_000, netEdge: 0.03 }); // hour 1, clears

    const rows = densityByHour(db, { minNetEdge: 0.005 });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].hourMs, T0, 'buckets are floored to the hour');
    assert.equal(rows[0].total, 3);
    assert.equal(rows[0].priced, 2);
    assert.equal(rows[0].skipped, 1);
    assert.equal(rows[0].clears, 1);
    assert.equal(rows[1].hourMs, T0 + HOUR);
    assert.equal(rows[1].clears, 1);
  });
});

// ── categoryBreakdown ───────────────────────────────────────────────────────

test('categoryBreakdown joins legs to markets and reports the fee-free bucket apart', () => {
  withDb((db) => {
    // The fee-free bucket is structurally different: it is where taker arbitrage still
    // works cleanly, so lumping it in with charged categories would hide the signal.
    seedMarket(db, { tokenId: 't1', category: 'politics', feeRate: 0.04 });
    seedMarket(db, { tokenId: 't2', category: 'politics', feeRate: 0.04 });
    seedMarket(db, { tokenId: 't3', category: 'geopolitics', feeRate: 0 });
    seedMarket(db, { tokenId: 't4', category: 'geopolitics', feeRate: 0 });

    seedOpp(db, {
      eventKey: 'p1', ts: T0 + 1, netEdge: -0.02, capacityUsd: 10,
      legs: [{ tokenId: 't1' }, { tokenId: 't2', outcome: 'No' }],
    });
    seedOpp(db, {
      eventKey: 'g1', ts: T0 + 2, netEdge: 0.02, capacityUsd: 100,
      legs: [{ tokenId: 't3' }, { tokenId: 't4', outcome: 'No' }],
    });
    seedOpp(db, {
      eventKey: 'g2', ts: T0 + 3, netEdge: 0.03, capacityUsd: 200,
      legs: [{ tokenId: 't3' }, { tokenId: 't4', outcome: 'No' }],
    });

    const rows = categoryBreakdown(db, { minNetEdge: 0.005 });
    const byCat = Object.fromEntries(rows.map((r) => [r.category, r]));

    assert.equal(byCat.politics.priced, 1);
    assert.equal(byCat.politics.clears, 0);
    assert.equal(byCat.geopolitics.priced, 2);
    assert.equal(byCat.geopolitics.clears, 2);
    closeTo(byCat.geopolitics.bestNetEdge, 0.03, 'best geopolitics edge');
    assert.equal(byCat.geopolitics.feeFree, true, 'flagged as the zero-rate bucket');
    assert.equal(byCat.politics.feeFree, false);
  });
});

test('categoryBreakdown counts a set once, not once per leg', () => {
  // The join fans out over legs; a naive COUNT(*) would report a 2-leg set as two
  // observations and a 30-leg neg-risk set as thirty, silently weighting big groups.
  withDb((db) => {
    seedMarket(db, { tokenId: 'a', category: 'politics' });
    seedMarket(db, { tokenId: 'b', category: 'politics' });
    seedMarket(db, { tokenId: 'c', category: 'politics' });
    seedOpp(db, {
      eventKey: 'big', ts: T0 + 1, kind: 'neg_risk', legCount: 3, netEdge: 0.02, capacityUsd: 10,
      legs: [{ tokenId: 'a' }, { tokenId: 'b' }, { tokenId: 'c' }],
    });
    const [row] = categoryBreakdown(db, { minNetEdge: 0.005 });
    assert.equal(row.priced, 1, 'one set, not three');
    assert.equal(row.clears, 1);
  });
});

test('categoryBreakdown reports sets whose tokens are not in markets as uncategorised', () => {
  withDb((db) => {
    seedOpp(db, { eventKey: 'x', ts: T0 + 1, netEdge: 0.02, legs: [{ tokenId: 'unknown' }] });
    const rows = categoryBreakdown(db, { minNetEdge: 0.005 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].category, '(unknown)', 'not silently dropped');
    assert.equal(rows[0].priced, 1);
  });
});

// ── capacityBinding ─────────────────────────────────────────────────────────

test('capacityBinding separates a thin book from a bound notional cap', () => {
  // The two call for opposite responses: a thin book means wait, a bound cap means add
  // capital. A single capacity number cannot tell them apart.
  withDb((db) => {
    seedOpp(db, { eventKey: 'a', ts: T0 + 1, netEdge: 0.02, bindingLeg: '0', capacityUsd: 10 });
    seedOpp(db, { eventKey: 'b', ts: T0 + 2, netEdge: 0.02, bindingLeg: '1', capacityUsd: 20 });
    seedOpp(db, { eventKey: 'c', ts: T0 + 3, netEdge: 0.02, bindingLeg: 'notional', capacityUsd: 250 });
    seedOpp(db, { eventKey: 'd', ts: T0 + 4, skipReason: 'stale_book' });

    const b = capacityBinding(db, {});
    assert.equal(b.book, 2, 'a leg index means the book bound');
    assert.equal(b.notional, 1);
    assert.equal(b.unsized, 1, 'the skipped row had no capacity at all');
    closeTo(b.medianCapacityUsd, 20, 'median of 10, 20, 250');
  });
});

// ── recentClears ────────────────────────────────────────────────────────────

test('recentClears returns the newest clearing sets, newest first', () => {
  withDb((db) => {
    seedOpp(db, { eventKey: 'old', ts: T0 + 1, netEdge: 0.02, capacityUsd: 10 });
    seedOpp(db, { eventKey: 'mid', ts: T0 + 2, netEdge: 0.03, capacityUsd: 20 });
    seedOpp(db, { eventKey: 'new', ts: T0 + 3, netEdge: 0.04, capacityUsd: 30 });
    seedOpp(db, { eventKey: 'miss', ts: T0 + 4, netEdge: 0.001, capacityUsd: 40 });

    const rows = recentClears(db, { minNetEdge: 0.005, limit: 2 });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.eventKey), ['new', 'mid']);
    closeTo(rows[0].netEdge, 0.04, 'netEdge');
  });
});

test('recentClears bounds the limit so a caller cannot pull the whole table', () => {
  withDb((db) => {
    for (let i = 0; i < 5; i += 1) {
      seedOpp(db, { eventKey: `e${i}`, ts: T0 + i, netEdge: 0.02 });
    }
    assert.equal(recentClears(db, { minNetEdge: 0.005, limit: 0 }).length, 1, 'floored to 1');
    assert.equal(recentClears(db, { minNetEdge: 0.005, limit: 10_000 }).length, 5, 'capped');
    assert.throws(
      () => recentClears(db, { minNetEdge: 0.005, limit: 'lots' }),
      /limit must be a finite number/,
    );
  });
});
