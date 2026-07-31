import { test } from 'node:test';
import assert from 'node:assert/strict';

import { venueTakerFeeFn } from '../lib/fees.mjs';
import {
  KIND_BINARY,
  KIND_NEG_RISK,
  binaryComplementEdge,
  clearsThreshold,
  detectOpportunity,
  negRiskSetEdge,
  setCapacity,
} from '../lib/arb.mjs';

const EPS = 1e-12;

function closeTo(actual, expected, message) {
  assert.ok(
    Math.abs(actual - expected) < EPS,
    `${message ?? 'value'}: expected ${expected} +/- ${EPS}, got ${actual}`,
  );
}

/** Helpers build INPUTS only. */
const politics = () => venueTakerFeeFn('polymarket', { category: 'politics' });
const crypto = () => venueTakerFeeFn('polymarket', { category: 'crypto' });
const geopolitics = () => venueTakerFeeFn('polymarket', { category: 'geopolitics' });
const kalshi = () => venueTakerFeeFn('kalshi');

// ── binaryComplementEdge ────────────────────────────────────────────────────

test('binaryComplementEdge prices the worked politics case', () => {
  // gross = 0.50 + 0.45                       = 0.95
  // fees  = 0.04*0.5*0.5 + 0.04*0.45*0.55     = 0.01 + 0.0099 = 0.0199
  // allIn = 0.95 + 0.0199                     = 0.9699
  // net   = 1 - 0.9699                        = 0.0301
  const r = binaryComplementEdge({ legs: [{ price: 0.5 }, { price: 0.45 }], feeFn: politics() });
  assert.equal(r.kind, KIND_BINARY);
  closeTo(r.grossCost, 0.95, 'grossCost');
  closeTo(r.totalFee, 0.0199, 'totalFee');
  closeTo(r.allInCost, 0.9699, 'allInCost');
  closeTo(r.netEdge, 0.0301, 'netEdge');
});

test('binaryComplementEdge requires exactly two legs', () => {
  const feeFn = politics();
  assert.throws(
    () => binaryComplementEdge({ legs: [{ price: 0.5 }, { price: 0.3 }, { price: 0.1 }], feeFn }),
    /binary complement needs exactly 2 legs, got 3/,
  );
  assert.throws(
    () => binaryComplementEdge({ legs: [{ price: 0.5 }], feeFn }),
    /binary complement needs exactly 2 legs, got 1/,
  );
  // Not an array at all — reported by value, not as a misleading length.
  assert.throws(
    () => binaryComplementEdge({ legs: 'nope', feeFn }),
    /binary complement needs exactly 2 legs, got nope/,
  );
});

test('binaryComplementEdge reports a NEGATIVE edge honestly rather than throwing', () => {
  // An unprofitable set is information, not an error — only the threshold decides
  // tradeability, and recording the misses is how edge decay becomes visible.
  // gross = 0.60 + 0.55 = 1.15, fees = 0.04*0.6*0.4 + 0.04*0.55*0.45 = 0.0096 + 0.0099 = 0.0195
  // net   = 1 - 1.1695 = -0.1695
  const r = binaryComplementEdge({ legs: [{ price: 0.6 }, { price: 0.55 }], feeFn: politics() });
  closeTo(r.grossCost, 1.15, 'grossCost');
  closeTo(r.totalFee, 0.0195, 'totalFee');
  closeTo(r.netEdge, -0.1695, 'netEdge');
});

// ── negRiskSetEdge ──────────────────────────────────────────────────────────

test('negRiskSetEdge prices the worked three-outcome Kalshi case', () => {
  // gross = 0.50 + 0.30 + 0.15                                    = 0.95
  // fees  = 0.07*0.5*0.5 + 0.07*0.3*0.7 + 0.07*0.15*0.85
  //       = 0.0175 + 0.0147 + 0.0089250                           = 0.0411250
  // allIn = 0.95 + 0.041125                                       = 0.991125
  // net   = 1 - 0.991125                                          = 0.008875
  const r = negRiskSetEdge({
    legs: [{ price: 0.5 }, { price: 0.3 }, { price: 0.15 }],
    feeFn: kalshi(),
  });
  assert.equal(r.kind, KIND_NEG_RISK);
  closeTo(r.grossCost, 0.95, 'grossCost');
  closeTo(r.totalFee, 0.041125, 'totalFee');
  closeTo(r.allInCost, 0.991125, 'allInCost');
  closeTo(r.netEdge, 0.008875, 'netEdge');
});

test('negRiskSetEdge accepts two or more legs', () => {
  const feeFn = kalshi();
  assert.equal(negRiskSetEdge({ legs: [{ price: 0.5 }, { price: 0.4 }], feeFn }).kind, KIND_NEG_RISK);
  assert.throws(
    () => negRiskSetEdge({ legs: [{ price: 0.5 }], feeFn }),
    /at least 2 legs/,
  );
});

test('the two kinds share identical arithmetic and differ only in label', () => {
  // The payoff is the same $1 per complete set either way; the kind exists because the
  // mechanics to unwind differ (CTF merge vs NegRiskAdapter convert) and for reporting.
  const legs = [{ price: 0.5 }, { price: 0.45 }];
  const bin = binaryComplementEdge({ legs, feeFn: politics() });
  const neg = negRiskSetEdge({ legs, feeFn: politics() });
  closeTo(bin.netEdge, neg.netEdge, 'netEdge matches');
  closeTo(bin.totalFee, neg.totalFee, 'totalFee matches');
  assert.equal(bin.kind, 'binary');
  assert.equal(neg.kind, 'neg_risk');
});

// ── THE central test: fees can invert a positive gross edge ─────────────────

test('a GROSS-profitable set can be FEE-NEGATIVE — the whole reason this module exists', () => {
  // Crypto carries the 0.07 rate. YES 0.50 / NO 0.49 looks like a penny of free money
  // and is a 2.5-cent loss once the real taker fee is charged on both legs.
  //   gross     = 0.50 + 0.49                        = 0.99   -> "+1c gross edge"
  //   fees      = 0.07*0.5*0.5 + 0.07*0.49*0.51
  //             = 0.0175 + 0.017493                  = 0.034993
  //   allIn     = 0.99 + 0.034993                    = 1.024993
  //   net       = 1 - 1.024993                       = -0.024993
  const r = binaryComplementEdge({ legs: [{ price: 0.5 }, { price: 0.49 }], feeFn: crypto() });
  closeTo(r.grossCost, 0.99, 'grossCost');
  closeTo(1 - r.grossCost, 0.01, 'gross edge is POSITIVE');
  closeTo(r.totalFee, 0.034993, 'totalFee');
  closeTo(r.netEdge, -0.024993, 'net edge is NEGATIVE');
  assert.ok(1 - r.grossCost > 0 && r.netEdge < 0, 'gross positive, net negative');

  // And the threshold must reject it — this is the failure mode that fires real orders
  // at a loss if the fee model is wrong or absent.
  assert.equal(clearsThreshold(r, { minNetEdge: 0.005 }), false);
});

test('the same set is profitable on a cheaper category — the fee rate alone decides', () => {
  // Identical prices, politics (0.04) instead of crypto (0.07):
  //   fees = 0.04*0.5*0.5 + 0.04*0.49*0.51 = 0.01 + 0.009996 = 0.019996
  //   net  = 1 - (0.99 + 0.019996) = -0.009996  -> still negative
  const r = binaryComplementEdge({ legs: [{ price: 0.5 }, { price: 0.49 }], feeFn: politics() });
  closeTo(r.totalFee, 0.019996, 'politics totalFee');
  closeTo(r.netEdge, -0.009996, 'still negative, but less so');
  // Fee-free geopolitics is the only one where the penny survives.
  const free = binaryComplementEdge({ legs: [{ price: 0.5 }, { price: 0.49 }], feeFn: geopolitics() });
  assert.equal(free.totalFee, 0);
  closeTo(free.netEdge, 0.01, 'fee-free keeps the full penny');
  assert.equal(clearsThreshold(free, { minNetEdge: 0.005 }), true);
});

test('SAME gross cost, different outcome — purely because of the fee SHAPE', () => {
  // Both sets cost exactly 0.95 gross. The lopsided one nets far more because p(1-p)
  // fees collapse toward the price extremes. A flat threshold cannot express this.
  //   even     0.50/0.45: fees 0.0199 -> net 0.0301
  //   lopsided 0.90/0.05: fees 0.0055 -> net 0.0445
  const even = binaryComplementEdge({ legs: [{ price: 0.5 }, { price: 0.45 }], feeFn: politics() });
  const lopsided = binaryComplementEdge({ legs: [{ price: 0.9 }, { price: 0.05 }], feeFn: politics() });
  closeTo(even.grossCost, 0.95, 'even grossCost');
  closeTo(lopsided.grossCost, 0.95, 'lopsided grossCost');
  closeTo(even.netEdge, 0.0301, 'even netEdge');
  closeTo(lopsided.netEdge, 0.0445, 'lopsided netEdge');

  // A threshold between the two nets accepts one and rejects the other, despite an
  // identical gross price.
  assert.equal(clearsThreshold(even, { minNetEdge: 0.04 }), false);
  assert.equal(clearsThreshold(lopsided, { minNetEdge: 0.04 }), true);
});

// ── clearsThreshold ─────────────────────────────────────────────────────────

test('clearsThreshold compares net edge inclusively against the floor', () => {
  const r = { netEdge: 0.02, skipped: null };
  assert.equal(clearsThreshold(r, { minNetEdge: 0.019 }), true);
  assert.equal(clearsThreshold(r, { minNetEdge: 0.02 }), true, 'exactly at the floor clears');
  assert.equal(clearsThreshold(r, { minNetEdge: 0.021 }), false);
});

test('clearsThreshold rejects a skipped result outright', () => {
  assert.equal(clearsThreshold({ netEdge: null, skipped: 'stale_book' }, { minNetEdge: 0.005 }), false);
});

test('a set priced at exactly $1 with zero fees is not a tradeable edge', () => {
  // Float error here is ~1e-16 while any configured floor is >= 0.005, so no epsilon
  // fudge is needed — but the property is asserted rather than assumed.
  const r = binaryComplementEdge({ legs: [{ price: 0.6 }, { price: 0.4 }], feeFn: geopolitics() });
  assert.ok(Math.abs(r.netEdge) < EPS, `expected ~0 net edge, got ${r.netEdge}`);
  assert.equal(clearsThreshold(r, { minNetEdge: 0.005 }), false);
  assert.equal(clearsThreshold(r, { minNetEdge: 1e-9 }), false);
});

test('clearsThreshold requires a positive floor, matching the config rule', () => {
  const r = { netEdge: 0.02, skipped: null };
  // Includes 1.01: the floor is a price fraction, so a value above 1 is a
  // misunderstanding (a percentage, probably) and can never be met.
  for (const bad of [0, -0.01, 1.01, Number.NaN, '0.005', null, undefined]) {
    assert.throws(
      () => clearsThreshold(r, { minNetEdge: bad }),
      /minNetEdge must be a finite number in \(0, 1\]/,
      `expected minNetEdge ${String(bad)} to be rejected`,
    );
  }
});

// ── setCapacity ─────────────────────────────────────────────────────────────

test('setCapacity binds on min(SHARES), never min(dollars)', () => {
  // Leg 0: 0.90 x 100 shares = $90   <- fewest SHARES
  // Leg 1: 0.05 x 500 shares = $25   <- fewest DOLLARS
  // The two disagree, which is the whole point: an arb locks $1 per share-SET, so the
  // thin leg is the one with fewer SHARES. Sizing off dollars would pick leg 1 and
  // authorise 500 shares against a book that only holds 100.
  // allInCostPerSet (politics 0.90/0.05) = 0.95 + 0.0055 = 0.9555
  const cap = setCapacity({
    legs: [{ price: 0.9, sizeShares: 100 }, { price: 0.05, sizeShares: 500 }],
    safetyFactor: 0.5,
    maxSetSizeUsd: 10_000,
    allInCostPerSet: 0.9555,
  });
  // shares = min(100, 500) * 0.5 = 50
  closeTo(cap.capacityShares, 50, 'capacityShares');
  // usd = 50 * 0.9555 = 47.775
  closeTo(cap.capacityUsd, 47.775, 'capacityUsd');
  assert.equal(cap.bindingLeg, 0, 'the SHARE-thin leg binds');
  // Sizing off dollars would have produced 250 shares — a 5x oversize.
  assert.notEqual(cap.capacityShares, 250);
});

test('setCapacity reports the notional cap when IT binds instead of a leg', () => {
  // geopolitics is fee-free, so allInCostPerSet = 0.60 + 0.30 = 0.90.
  // 1000 shares x 0.90 = $900, above a $450 cap -> shares reduced to 450/0.90 = 500.
  const cap = setCapacity({
    legs: [{ price: 0.6, sizeShares: 1000 }, { price: 0.3, sizeShares: 1000 }],
    safetyFactor: 1,
    maxSetSizeUsd: 450,
    allInCostPerSet: 0.9,
  });
  closeTo(cap.capacityShares, 500, 'capacityShares');
  closeTo(cap.capacityUsd, 450, 'capacityUsd');
  assert.equal(cap.bindingLeg, 'notional', 'the USD cap binds, not the book');
});

test('setCapacity reports the thinnest leg index when the book binds', () => {
  const cap = setCapacity({
    legs: [{ price: 0.6, sizeShares: 900 }, { price: 0.3, sizeShares: 400 }, { price: 0.05, sizeShares: 700 }],
    safetyFactor: 1,
    maxSetSizeUsd: 10_000,
    allInCostPerSet: 0.95,
  });
  closeTo(cap.capacityShares, 400, 'capacityShares');
  // 400 * 0.95 = 380
  closeTo(cap.capacityUsd, 380, 'capacityUsd');
  assert.equal(cap.bindingLeg, 1, 'leg 1 is thinnest');
});

test('setCapacity picks the FIRST thinnest leg when several tie', () => {
  const cap = setCapacity({
    legs: [{ price: 0.5, sizeShares: 200 }, { price: 0.4, sizeShares: 200 }],
    safetyFactor: 1,
    maxSetSizeUsd: 10_000,
    allInCostPerSet: 0.9,
  });
  assert.equal(cap.bindingLeg, 0);
  closeTo(cap.capacityShares, 200, 'capacityShares');
});

test('setCapacity applies the safety factor before the notional cap', () => {
  // shares = min(1000,1000) * 0.25 = 250 -> 250 * 0.90 = $225, under a $450 cap,
  // so the leg binds and the cap does not.
  const cap = setCapacity({
    legs: [{ price: 0.6, sizeShares: 1000 }, { price: 0.3, sizeShares: 1000 }],
    safetyFactor: 0.25,
    maxSetSizeUsd: 450,
    allInCostPerSet: 0.9,
  });
  closeTo(cap.capacityShares, 250, 'capacityShares');
  closeTo(cap.capacityUsd, 225, 'capacityUsd');
  assert.equal(cap.bindingLeg, 0);
});

test('setCapacity rejects a non-positive or non-finite sizeShares, naming the leg', () => {
  const base = {
    safetyFactor: 0.5,
    maxSetSizeUsd: 1000,
    allInCostPerSet: 0.95,
  };
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '100', null, undefined]) {
    assert.throws(
      () => setCapacity({ ...base, legs: [{ price: 0.5, sizeShares: 100 }, { price: 0.4, sizeShares: bad }] }),
      /leg 1 sizeShares must be a finite number greater than 0/,
      `expected sizeShares ${String(bad)} to be rejected`,
    );
  }
});

test('setCapacity rejects a null leg rather than reading through it', () => {
  assert.throws(
    () => setCapacity({
      legs: [{ price: 0.5, sizeShares: 100 }, null],
      safetyFactor: 0.5,
      maxSetSizeUsd: 1000,
      allInCostPerSet: 0.9,
    }),
    /leg 1 sizeShares must be a finite number greater than 0/,
  );
});

test('setCapacity enforces the same (0,1] safety-factor rule as the config layer', () => {
  const base = {
    legs: [{ price: 0.5, sizeShares: 100 }, { price: 0.4, sizeShares: 100 }],
    maxSetSizeUsd: 1000,
    allInCostPerSet: 0.9,
  };
  // 0 is invalid: it is not "disabled", it sizes every trade to nothing.
  for (const bad of [0, -0.1, 1.01, Number.NaN, '0.5']) {
    assert.throws(
      () => setCapacity({ ...base, safetyFactor: bad }),
      /safetyFactor must be a finite number in \(0, 1\]/,
      `expected safetyFactor ${String(bad)} to be rejected`,
    );
  }
  assert.doesNotThrow(() => setCapacity({ ...base, safetyFactor: 1 }));
});

test('setCapacity rejects a non-positive maxSetSizeUsd or allInCostPerSet', () => {
  const base = {
    legs: [{ price: 0.5, sizeShares: 100 }, { price: 0.4, sizeShares: 100 }],
    safetyFactor: 0.5,
    allInCostPerSet: 0.9,
  };
  for (const bad of [0, -1, Number.NaN, '100']) {
    assert.throws(
      () => setCapacity({ ...base, maxSetSizeUsd: bad }),
      /maxSetSizeUsd must be a finite number greater than 0/,
      `expected maxSetSizeUsd ${String(bad)} to be rejected`,
    );
  }
  for (const bad of [0, -1, Number.NaN]) {
    assert.throws(
      () => setCapacity({ ...base, maxSetSizeUsd: 100, allInCostPerSet: bad }),
      /allInCostPerSet must be a finite number greater than 0/,
      `expected allInCostPerSet ${String(bad)} to be rejected`,
    );
  }
});

test('setCapacity requires at least two legs', () => {
  const base = { safetyFactor: 0.5, maxSetSizeUsd: 100, allInCostPerSet: 0.9 };
  assert.throws(
    () => setCapacity({ ...base, legs: [{ price: 0.5, sizeShares: 100 }] }),
    /at least 2 legs, got 1/,
  );
  assert.throws(() => setCapacity({ ...base, legs: [] }), /at least 2 legs, got 0/);
  assert.throws(() => setCapacity({ ...base, legs: 'nope' }), /at least 2 legs, got nope/);
});

// ── detectOpportunity ───────────────────────────────────────────────────────

const CFG = Object.freeze({ bookStaleMs: 750, minNetEdge: 0.005, depthSafetyFactor: 0.5, maxSetSizeUsd: 250 });

test('detectOpportunity returns a row shaped for the opportunities schema', () => {
  const out = detectOpportunity({
    venue: 'polymarket',
    eventKey: 'evt-1',
    kind: KIND_BINARY,
    legs: [
      { tokenId: 'yes', outcome: 'YES', price: 0.5, sizeShares: 400, bookTs: 1_000_000 },
      { tokenId: 'no', outcome: 'NO', price: 0.45, sizeShares: 600, bookTs: 1_000_000 },
    ],
    feeFn: politics(),
    cfg: CFG,
    nowMs: 1_000_500,
  });
  assert.equal(out.venue, 'polymarket');
  assert.equal(out.eventKey, 'evt-1');
  assert.equal(out.kind, 'binary');
  assert.equal(out.legCount, 2);
  assert.equal(out.skipped, null);
  closeTo(out.grossCost, 0.95, 'grossCost');
  closeTo(out.totalFee, 0.0199, 'totalFee');
  closeTo(out.netEdge, 0.0301, 'netEdge');
  // shares = min(400,600) * 0.5 = 200; usd = 200 * 0.9699 = 193.98
  closeTo(out.capacityShares, 200, 'capacityShares');
  closeTo(out.capacityUsd, 193.98, 'capacityUsd');
  assert.equal(out.bookAgeMs, 500);
  assert.equal(out.clears, true);
});

test('detectOpportunity SKIPS a stale book and makes no edge claim at all', () => {
  // The dominant live-vs-backtest gap: a displayed crossing is disproportionately one
  // somebody is already taking or cancelling. A stale read must not become a number.
  const out = detectOpportunity({
    venue: 'polymarket',
    eventKey: 'evt-1',
    kind: KIND_BINARY,
    legs: [
      { price: 0.5, sizeShares: 400, bookTs: 1_000_000 },
      { price: 0.45, sizeShares: 600, bookTs: 1_000_000 },
    ],
    feeFn: politics(),
    cfg: CFG,
    nowMs: 1_001_000, // 1000ms old, past the 750ms gate
  });
  assert.equal(out.skipped, 'stale_book');
  assert.equal(out.clears, false);
  assert.equal(out.netEdge, null, 'no edge is claimed');
  assert.equal(out.grossCost, null);
  assert.equal(out.totalFee, null);
  assert.equal(out.capacityShares, null);
  assert.equal(out.capacityUsd, null);
  assert.equal(out.bookAgeMs, 1000, 'the age is still recorded, so skips are measurable');
});

test('detectOpportunity ages from the OLDEST leg, not the freshest', () => {
  // One fresh leg cannot vouch for a stale one — the trade needs both books.
  const out = detectOpportunity({
    venue: 'polymarket',
    eventKey: 'evt-1',
    kind: KIND_BINARY,
    legs: [
      { price: 0.5, sizeShares: 400, bookTs: 1_000_900 }, // 100ms old
      { price: 0.45, sizeShares: 600, bookTs: 1_000_000 }, // 1000ms old
    ],
    feeFn: politics(),
    cfg: CFG,
    nowMs: 1_001_000,
  });
  assert.equal(out.bookAgeMs, 1000);
  assert.equal(out.skipped, 'stale_book');
});

test('detectOpportunity accepts a book exactly at the staleness bound', () => {
  const out = detectOpportunity({
    venue: 'polymarket',
    eventKey: 'evt-1',
    kind: KIND_BINARY,
    legs: [
      { price: 0.5, sizeShares: 400, bookTs: 1_000_250 },
      { price: 0.45, sizeShares: 600, bookTs: 1_000_250 },
    ],
    feeFn: politics(),
    cfg: CFG,
    nowMs: 1_001_000, // exactly 750ms
  });
  assert.equal(out.bookAgeMs, 750);
  assert.equal(out.skipped, null);
});

test('detectOpportunity falls back to a top-level bookTs for legs without one', () => {
  const out = detectOpportunity({
    venue: 'kalshi',
    eventKey: 'evt-2',
    kind: KIND_NEG_RISK,
    legs: [{ price: 0.5, sizeShares: 100 }, { price: 0.3, sizeShares: 100 }, { price: 0.15, sizeShares: 100 }],
    feeFn: kalshi(),
    cfg: CFG,
    nowMs: 1_000_400,
    bookTs: 1_000_000,
  });
  assert.equal(out.bookAgeMs, 400);
  assert.equal(out.legCount, 3);
  closeTo(out.netEdge, 0.008875, 'netEdge');
  assert.equal(out.clears, true);
});

test('detectOpportunity records a sub-threshold result instead of hiding it', () => {
  // Recording the near-misses is how edge decay becomes visible later.
  const out = detectOpportunity({
    venue: 'polymarket',
    eventKey: 'evt-3',
    kind: KIND_BINARY,
    legs: [
      { price: 0.5, sizeShares: 400, bookTs: 1_000_000 },
      { price: 0.49, sizeShares: 600, bookTs: 1_000_000 },
    ],
    feeFn: crypto(),
    cfg: CFG,
    nowMs: 1_000_100,
  });
  assert.equal(out.skipped, null);
  closeTo(out.netEdge, -0.024993, 'the loss is recorded, not suppressed');
  assert.equal(out.clears, false);
});

test('detectOpportunity requires a known kind', () => {
  assert.throws(
    () => detectOpportunity({
      venue: 'polymarket',
      eventKey: 'e',
      kind: 'combinatorial',
      legs: [{ price: 0.5, sizeShares: 1, bookTs: 0 }, { price: 0.4, sizeShares: 1, bookTs: 0 }],
      feeFn: politics(),
      cfg: CFG,
      nowMs: 0,
    }),
    /kind must be 'binary' or 'neg_risk'/,
  );
});

test('detectOpportunity requires a usable nowMs and cfg', () => {
  const base = {
    venue: 'polymarket',
    eventKey: 'e',
    kind: KIND_BINARY,
    legs: [{ price: 0.5, sizeShares: 1, bookTs: 0 }, { price: 0.4, sizeShares: 1, bookTs: 0 }],
    feeFn: politics(),
  };
  assert.throws(() => detectOpportunity({ ...base, cfg: CFG, nowMs: Number.NaN }), /nowMs must be a finite number/);
  assert.throws(() => detectOpportunity({ ...base, cfg: null, nowMs: 0 }), /cfg must be an object/);
});

test('detectOpportunity requires at least two legs — a single leg is not a set', () => {
  const base = {
    venue: 'polymarket',
    eventKey: 'e',
    kind: KIND_BINARY,
    feeFn: politics(),
    cfg: CFG,
    nowMs: 0,
  };
  assert.throws(
    () => detectOpportunity({ ...base, legs: [{ price: 0.5, sizeShares: 1, bookTs: 0 }] }),
    /a complete set needs at least 2 legs, got 1/,
  );
  assert.throws(() => detectOpportunity({ ...base, legs: [] }), /at least 2 legs, got 0/);
  assert.throws(() => detectOpportunity({ ...base, legs: 'nope' }), /at least 2 legs, got nope/);
});

test('detectOpportunity rejects a null leg rather than reading through it', () => {
  assert.throws(
    () => detectOpportunity({
      venue: 'polymarket',
      eventKey: 'e',
      kind: KIND_BINARY,
      legs: [{ price: 0.5, sizeShares: 1, bookTs: 0 }, null],
      feeFn: politics(),
      cfg: CFG,
      nowMs: 0,
    }),
    /leg 1 bookTs must be a finite number/,
  );
});

test('detectOpportunity rejects a leg whose bookTs is missing or unusable', () => {
  assert.throws(
    () => detectOpportunity({
      venue: 'polymarket',
      eventKey: 'e',
      kind: KIND_BINARY,
      legs: [{ price: 0.5, sizeShares: 1, bookTs: 0 }, { price: 0.4, sizeShares: 1 }],
      feeFn: politics(),
      cfg: CFG,
      nowMs: 0,
    }),
    /leg 1 bookTs must be a finite number/,
  );
});
