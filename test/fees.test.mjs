import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LIMITLESS_BUY_CURVE,
  LIMITLESS_SELL_CURVE,
  POLYMARKET_FEE_RATES,
  completeSetCost,
  kalshiTakerFee,
  limitlessTakerFee,
  polymarketTakerFee,
  venueTakerFeeFn,
} from '../lib/fees.mjs';

/**
 * Binary floating point makes exact equality fragile for these products
 * (0.04 * 0.9 * 0.1 is 0.0035999999999999995, not 0.0036), so every non-zero
 * expectation is compared within this tolerance. Exact zeros are asserted exactly.
 */
const EPS = 1e-12;

function closeTo(actual, expected, message) {
  assert.ok(
    Math.abs(actual - expected) < EPS,
    `${message ?? 'value'}: expected ${expected} +/- ${EPS}, got ${actual}`,
  );
}

// ── POLYMARKET_FEE_RATES ────────────────────────────────────────────────────

test('POLYMARKET_FEE_RATES carries the verified per-category rates', () => {
  assert.equal(POLYMARKET_FEE_RATES.crypto, 0.07);
  assert.equal(POLYMARKET_FEE_RATES.sports, 0.05);
  assert.equal(POLYMARKET_FEE_RATES.economics, 0.05);
  assert.equal(POLYMARKET_FEE_RATES.culture, 0.05);
  assert.equal(POLYMARKET_FEE_RATES.weather, 0.05);
  assert.equal(POLYMARKET_FEE_RATES.other, 0.05);
  assert.equal(POLYMARKET_FEE_RATES.politics, 0.04);
  assert.equal(POLYMARKET_FEE_RATES.finance, 0.04);
  assert.equal(POLYMARKET_FEE_RATES.tech, 0.04);
  assert.equal(POLYMARKET_FEE_RATES.mentions, 0.04);
  assert.equal(POLYMARKET_FEE_RATES.geopolitics, 0);
});

test('POLYMARKET_FEE_RATES is frozen', () => {
  assert.equal(Object.isFrozen(POLYMARKET_FEE_RATES), true);
  assert.throws(() => {
    POLYMARKET_FEE_RATES.politics = 0;
  }, TypeError);
  assert.equal(POLYMARKET_FEE_RATES.politics, 0.04);
});

// ── polymarketTakerFee ──────────────────────────────────────────────────────

test('polymarketTakerFee is rate x p x (1-p) per share', () => {
  // 0.04 * 0.5 * 0.5 = 0.01
  closeTo(polymarketTakerFee(0.5, 'politics'), 0.01, 'politics @0.50');
  // 0.04 * 0.9 * 0.1 = 0.0036
  closeTo(polymarketTakerFee(0.9, 'politics'), 0.0036, 'politics @0.90');
  // 0.04 * 0.45 * 0.55 = 0.0099
  closeTo(polymarketTakerFee(0.45, 'politics'), 0.0099, 'politics @0.45');
  // 0.07 * 0.5 * 0.5 = 0.0175
  closeTo(polymarketTakerFee(0.5, 'crypto'), 0.0175, 'crypto @0.50');
  // 0.05 * 0.2 * 0.8 = 0.008
  closeTo(polymarketTakerFee(0.2, 'sports'), 0.008, 'sports @0.20');
});

test('polymarketTakerFee is symmetric about 0.5 — p and 1-p cost the same', () => {
  // 0.04 * 0.3 * 0.7 = 0.0084 and 0.04 * 0.7 * 0.3 = 0.0084
  closeTo(polymarketTakerFee(0.3, 'politics'), 0.0084, 'p=0.30');
  closeTo(polymarketTakerFee(0.7, 'politics'), 0.0084, 'p=0.70');
});

test('the p(1-p) shape makes fees SHRINK toward the price extremes', () => {
  // This is the exploitable structural fact: an arb on a lopsided market is far
  // cheaper than one at even odds, so a flat threshold is wrong by construction.
  // 0.04 * 0.5  * 0.5  = 0.01
  // 0.04 * 0.9  * 0.1  = 0.0036
  // 0.04 * 0.99 * 0.01 = 0.000396
  const mid = polymarketTakerFee(0.5, 'politics');
  const lopsided = polymarketTakerFee(0.9, 'politics');
  const extreme = polymarketTakerFee(0.99, 'politics');
  closeTo(mid, 0.01, 'mid');
  closeTo(lopsided, 0.0036, 'lopsided');
  closeTo(extreme, 0.000396, 'extreme');
  assert.ok(mid > lopsided && lopsided > extreme, 'fee must decrease toward the tails');
});

test('geopolitics is genuinely fee-free — exactly zero, at every price', () => {
  for (const p of [0.01, 0.25, 0.5, 0.75, 0.99]) {
    assert.equal(polymarketTakerFee(p, 'geopolitics'), 0, `p=${p}`);
  }
});

test('polymarketTakerFee accepts the degenerate endpoints as exactly zero fee', () => {
  // p(1-p) is 0 at both ends. completeSetCost rejects such prices as a resolved
  // market; the raw fee function is just arithmetic and need not.
  assert.equal(polymarketTakerFee(0, 'politics'), 0);
  assert.equal(polymarketTakerFee(1, 'politics'), 0);
});

test('polymarketTakerFee THROWS on an unknown category rather than assuming free', () => {
  // Defaulting an unknown category to 0 would understate cost and manufacture
  // arbitrage that does not exist — the single most expensive silent failure here.
  assert.throws(() => polymarketTakerFee(0.5, 'sportsball'), /unknown Polymarket category/);
  assert.throws(() => polymarketTakerFee(0.5, undefined), /unknown Polymarket category/);
  assert.throws(() => polymarketTakerFee(0.5, ''), /unknown Polymarket category/);
  assert.throws(() => polymarketTakerFee(0.5, null), /unknown Polymarket category/);
});

test('polymarketTakerFee category lookup is case-insensitive and trimmed', () => {
  closeTo(polymarketTakerFee(0.5, 'POLITICS'), 0.01, 'upper');
  closeTo(polymarketTakerFee(0.5, '  Politics  '), 0.01, 'padded');
});

test('polymarketTakerFee does not inherit Object.prototype keys as categories', () => {
  // A plain-object lookup would resolve 'constructor'/'toString' to a function and
  // silently produce NaN. The rate table must not be reachable through the prototype.
  for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    assert.throws(
      () => polymarketTakerFee(0.5, key),
      /unknown Polymarket category/,
      `expected ${key} to be rejected`,
    );
  }
});

test('polymarketTakerFee rejects a price outside [0,1] or non-finite', () => {
  for (const bad of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, '0.5', null]) {
    assert.throws(
      () => polymarketTakerFee(bad, 'politics'),
      /price must be a finite number in \[0, 1\]/,
      `expected price ${String(bad)} to be rejected`,
    );
  }
});

// ── kalshiTakerFee ──────────────────────────────────────────────────────────

test('kalshiTakerFee is 0.07 x p x (1-p) per share', () => {
  // 0.07 * 0.5 * 0.5 = 0.0175
  closeTo(kalshiTakerFee(0.5), 0.0175, '@0.50');
  // 0.07 * 0.62 * 0.38 = 0.016492
  closeTo(kalshiTakerFee(0.62), 0.016492, '@0.62');
  // 0.07 * 0.01 * 0.99 = 0.000693
  closeTo(kalshiTakerFee(0.01), 0.000693, '@0.01');
});

test('kalshiTakerFee is SIDE-INDEPENDENT: a NO buy at 1-p costs the YES fee at p', () => {
  // 0.07 * 0.62 * 0.38 = 0.016492 and 0.07 * 0.38 * 0.62 = 0.016492 — algebraically
  // the same expression, so no `side` handling is needed for this venue.
  closeTo(kalshiTakerFee(0.62), 0.016492, 'yes @0.62');
  closeTo(kalshiTakerFee(0.38), 0.016492, 'no  @0.38');
  for (const p of [0.05, 0.2, 0.37, 0.5, 0.81]) {
    closeTo(kalshiTakerFee(p), kalshiTakerFee(1 - p), `symmetry at ${p}`);
  }
});

test('kalshiTakerFee rejects a price outside [0,1] or non-finite', () => {
  for (const bad of [-0.01, 1.01, Number.NaN, '0.5']) {
    assert.throws(
      () => kalshiTakerFee(bad),
      /price must be a finite number in \[0, 1\]/,
      `expected price ${String(bad)} to be rejected`,
    );
  }
});

// ── limitlessTakerFee ───────────────────────────────────────────────────────

test('the Limitless curves are frozen and monotone in price along each table', () => {
  assert.equal(Object.isFrozen(LIMITLESS_BUY_CURVE), true);
  assert.equal(Object.isFrozen(LIMITLESS_SELL_CURVE), true);
  for (const curve of [LIMITLESS_BUY_CURVE, LIMITLESS_SELL_CURVE]) {
    for (let i = 1; i < curve.length; i += 1) {
      assert.ok(curve[i][0] > curve[i - 1][0], 'table prices must strictly ascend');
    }
  }
});

test('limitlessTakerFee is a RATE ON NOTIONAL — fee = rate x price, not rate x p x (1-p)', () => {
  // This is the structural difference from Polymarket/Kalshi. Conflating the two is
  // the exact error class ANALYSIS.md documents.
  // BUY @0.50: table rate 0.0300 -> 0.0300 * 0.50 = 0.015
  closeTo(limitlessTakerFee(0.5, 'BUY'), 0.015, 'buy @0.50');
  // If it were p(1-p)-shaped it would be 0.0300 * 0.5 * 0.5 = 0.0075 — half as much.
  assert.notEqual(limitlessTakerFee(0.5, 'BUY'), 0.0075);
});

test('limitlessTakerFee reproduces every BUY table point exactly', () => {
  const points = [
    [0.01, 0.03], [0.5, 0.03], [0.55, 0.0252], [0.6, 0.0213], [0.65, 0.018],
    [0.7, 0.0151], [0.75, 0.0126], [0.8, 0.0105], [0.85, 0.0085], [0.9, 0.0068],
    [0.95, 0.0053], [0.99, 0.0042], [0.999, 0.004],
  ];
  for (const [price, rate] of points) {
    closeTo(limitlessTakerFee(price, 'BUY'), rate * price, `buy @${price}`);
  }
});

test('limitlessTakerFee reproduces every SELL table point exactly', () => {
  const points = [
    [0.01, 0.0042], [0.05, 0.006], [0.1, 0.0078], [0.2, 0.0111], [0.3, 0.0132],
    [0.4, 0.0144], [0.5, 0.015], [0.6, 0.0144], [0.7, 0.0132], [0.8, 0.0111],
    [0.9, 0.0078], [0.95, 0.006], [0.99, 0.0045], [0.999, 0.0042],
  ];
  for (const [price, rate] of points) {
    closeTo(limitlessTakerFee(price, 'SELL'), rate * price, `sell @${price}`);
  }
});

test('limitlessTakerFee interpolates linearly between BUY table points', () => {
  // p=0.525 sits halfway between 0.50 (0.0300) and 0.55 (0.0252):
  //   rate = 0.0300 + 0.5 * (0.0252 - 0.0300) = 0.0276
  //   fee  = 0.0276 * 0.525 = 0.01449
  closeTo(limitlessTakerFee(0.525, 'BUY'), 0.01449, 'buy @0.525');
  // p=0.575 sits halfway between 0.55 (0.0252) and 0.60 (0.0213):
  //   rate = 0.0252 + 0.5 * (0.0213 - 0.0252) = 0.02325
  //   fee  = 0.02325 * 0.575 = 0.01336875
  closeTo(limitlessTakerFee(0.575, 'BUY'), 0.01336875, 'buy @0.575');
});

test('limitlessTakerFee interpolates linearly between SELL table points', () => {
  // p=0.25 sits halfway between 0.20 (0.0111) and 0.30 (0.0132):
  //   rate = 0.0111 + 0.5 * (0.0132 - 0.0111) = 0.01215
  //   fee  = 0.01215 * 0.25 = 0.0030375
  closeTo(limitlessTakerFee(0.25, 'SELL'), 0.0030375, 'sell @0.25');
});

test('limitlessTakerFee interpolates correctly OFF the midpoint too', () => {
  // Every interpolation case above sits at t=0.5, and a midpoint is blind to a whole
  // class of index bug: pairing x from one table point with y from the other gives the
  // SAME answer at t=0.5 (0.0276 either way) and a different one anywhere else. These
  // asymmetric cases are what actually pin the endpoint pairing down.
  //
  // BUY p=0.51, between 0.50 (0.0300) and 0.55 (0.0252), t = 0.01/0.05 = 0.2:
  //   rate = 0.0300 + 0.2 * (0.0252 - 0.0300) = 0.0300 - 0.00096 = 0.02904
  //   fee  = 0.02904 * 0.51 = 0.0148104          (mispaired would give 0.02616 -> 0.0133416)
  closeTo(limitlessTakerFee(0.51, 'BUY'), 0.0148104, 'buy @0.51');
  //
  // SELL p=0.22, between 0.20 (0.0111) and 0.30 (0.0132), t = 0.02/0.10 = 0.2:
  //   rate = 0.0111 + 0.2 * (0.0132 - 0.0111) = 0.0111 + 0.00042 = 0.01152
  //   fee  = 0.01152 * 0.22 = 0.0025344          (mispaired would give 0.01278 -> 0.0028116)
  closeTo(limitlessTakerFee(0.22, 'SELL'), 0.0025344, 'sell @0.22');
  //
  // And near the far end of the BUY table, t = (0.97-0.95)/(0.99-0.95) = 0.5 would be
  // symmetric again, so use t = 0.25: p = 0.96
  //   rate = 0.0053 + 0.25 * (0.0042 - 0.0053) = 0.0053 - 0.000275 = 0.005025
  //   fee  = 0.005025 * 0.96 = 0.004824
  closeTo(limitlessTakerFee(0.96, 'BUY'), 0.004824, 'buy @0.96');
});

test('limitlessTakerFee is monotone between adjacent BUY table points', () => {
  // A sampled sweep across one interval: the rate must fall steadily from 0.0300 at
  // 0.50 to 0.0252 at 0.55, so the per-notional rate never jumps or reverses inside a
  // segment. Compares consecutive samples to each other, not to the function's own
  // output as an oracle — each endpoint has its exact hand-computed test above.
  const rates = [];
  for (let p = 0.5; p <= 0.5501; p += 0.005) {
    rates.push(limitlessTakerFee(p, 'BUY') / p);
  }
  for (let i = 1; i < rates.length; i += 1) {
    assert.ok(rates[i] <= rates[i - 1] + EPS, `rate must not rise inside the segment at i=${i}`);
  }
  closeTo(rates[0], 0.03, 'segment start rate');
  closeTo(rates[rates.length - 1], 0.0252, 'segment end rate');
});

test('limitlessTakerFee clamps below the first and above the last table point', () => {
  // Below 0.01 the BUY rate stays 0.0300: 0.0300 * 0.005 = 0.00015
  closeTo(limitlessTakerFee(0.005, 'BUY'), 0.00015, 'buy @0.005');
  // Above 0.999 the BUY rate stays 0.0040: 0.0040 * 0.9995 = 0.003998
  closeTo(limitlessTakerFee(0.9995, 'BUY'), 0.003998, 'buy @0.9995');
  // SELL below 0.01 stays 0.0042: 0.0042 * 0.002 = 0.0000084
  closeTo(limitlessTakerFee(0.002, 'SELL'), 0.0000084, 'sell @0.002');
});

test('the BUY and SELL curves are NOT mirror images — they differ at the same price', () => {
  // @0.50 the buy rate is 0.0300 and the sell rate 0.0150: 0.015 vs 0.0075.
  closeTo(limitlessTakerFee(0.5, 'BUY'), 0.015, 'buy @0.50');
  closeTo(limitlessTakerFee(0.5, 'SELL'), 0.0075, 'sell @0.50');
  // @0.90 the ordering REVERSES: buy 0.0068 -> 0.00612, sell 0.0078 -> 0.00702.
  closeTo(limitlessTakerFee(0.9, 'BUY'), 0.00612, 'buy @0.90');
  closeTo(limitlessTakerFee(0.9, 'SELL'), 0.00702, 'sell @0.90');
  assert.ok(limitlessTakerFee(0.5, 'BUY') > limitlessTakerFee(0.5, 'SELL'));
  assert.ok(limitlessTakerFee(0.9, 'BUY') < limitlessTakerFee(0.9, 'SELL'));
});

test('limitlessTakerFee never decays to zero at the extremes, unlike p(1-p)', () => {
  // Polymarket's fee at p=0.999 is 0.07*0.999*0.001 ~ 0.00007 per share; Limitless
  // holds a ~0.40% floor. No single flat rate can represent both shapes safely.
  closeTo(limitlessTakerFee(0.999, 'BUY'), 0.0039960, 'buy @0.999');
  assert.ok(limitlessTakerFee(0.999, 'BUY') > polymarketTakerFee(0.999, 'crypto') * 10);
});

test('limitlessTakerFee requires an explicit, recognised side', () => {
  assert.throws(() => limitlessTakerFee(0.5, 'buy'), /side must be 'BUY' or 'SELL'/);
  assert.throws(() => limitlessTakerFee(0.5, undefined), /side must be 'BUY' or 'SELL'/);
  assert.throws(() => limitlessTakerFee(0.5, 'LONG'), /side must be 'BUY' or 'SELL'/);
});

test('limitlessTakerFee rejects a price outside [0,1] or non-finite', () => {
  for (const bad of [-0.01, 1.01, Number.NaN, '0.5']) {
    assert.throws(
      () => limitlessTakerFee(bad, 'BUY'),
      /price must be a finite number in \[0, 1\]/,
      `expected price ${String(bad)} to be rejected`,
    );
  }
});

// ── venueTakerFeeFn ─────────────────────────────────────────────────────────

test('venueTakerFeeFn returns a (price, side) closure per venue', () => {
  // 0.04 * 0.5 * 0.5 = 0.01
  closeTo(venueTakerFeeFn('polymarket', { category: 'politics' })(0.5, 'BUY'), 0.01, 'poly');
  // 0.07 * 0.5 * 0.5 = 0.0175
  closeTo(venueTakerFeeFn('kalshi')(0.5, 'BUY'), 0.0175, 'kalshi');
  // 0.0300 * 0.5 = 0.015
  closeTo(venueTakerFeeFn('limitless')(0.5, 'BUY'), 0.015, 'limitless');
});

test('the Polymarket closure ignores side; the Limitless closure does not', () => {
  const poly = venueTakerFeeFn('polymarket', { category: 'politics' });
  closeTo(poly(0.5, 'BUY'), poly(0.5, 'SELL'), 'polymarket is side-independent');
  const lim = venueTakerFeeFn('limitless');
  assert.notEqual(lim(0.5, 'BUY'), lim(0.5, 'SELL'));
});

test('venueTakerFeeFn is case-insensitive on the venue name', () => {
  closeTo(venueTakerFeeFn('KALSHI')(0.5, 'BUY'), 0.0175, 'upper');
  closeTo(venueTakerFeeFn(' Kalshi ')(0.5, 'BUY'), 0.0175, 'padded');
});

test('venueTakerFeeFn throws on an unknown venue', () => {
  assert.throws(() => venueTakerFeeFn('myriad'), /unknown venue/);
  assert.throws(() => venueTakerFeeFn(''), /unknown venue/);
  assert.throws(() => venueTakerFeeFn(undefined), /unknown venue/);
});

test('venueTakerFeeFn requires a category for Polymarket, at construction time', () => {
  // Fail when the closure is BUILT, not on the first priced leg — a scanner that
  // discovers this mid-detection has already wasted the opportunity.
  assert.throws(() => venueTakerFeeFn('polymarket'), /unknown Polymarket category/);
  assert.throws(() => venueTakerFeeFn('polymarket', {}), /unknown Polymarket category/);
  assert.throws(
    () => venueTakerFeeFn('polymarket', { category: 'nope' }),
    /unknown Polymarket category/,
  );
});

// ── completeSetCost ─────────────────────────────────────────────────────────

test('completeSetCost sums prices and per-leg fees', () => {
  const fee = venueTakerFeeFn('polymarket', { category: 'politics' });
  const out = completeSetCost([{ price: 0.5 }, { price: 0.45 }], fee);
  // gross = 0.5 + 0.45 = 0.95
  closeTo(out.grossCost, 0.95, 'grossCost');
  // fees = 0.04*0.5*0.5 + 0.04*0.45*0.55 = 0.01 + 0.0099 = 0.0199
  closeTo(out.totalFee, 0.0199, 'totalFee');
  // all-in = 0.95 + 0.0199 = 0.9699
  closeTo(out.allInCost, 0.9699, 'allInCost');
});

test('the ANALYSIS.md worked example: a lopsided set costs 3.6x less in fees', () => {
  // The reason the detection threshold cannot be a flat constant.
  const fee = venueTakerFeeFn('polymarket', { category: 'politics' });
  // even-odds set @0.50/0.45: 0.04*0.5*0.5 + 0.04*0.45*0.55 = 0.01 + 0.0099 = 0.0199
  const even = completeSetCost([{ price: 0.5 }, { price: 0.45 }], fee);
  closeTo(even.totalFee, 0.0199, 'even-odds fee ~ 2.0c');
  // lopsided set @0.90/0.05: 0.04*0.9*0.1 + 0.04*0.05*0.95 = 0.0036 + 0.0019 = 0.0055
  const lopsided = completeSetCost([{ price: 0.9 }, { price: 0.05 }], fee);
  closeTo(lopsided.totalFee, 0.0055, 'lopsided fee ~ 0.55c');
  // 0.0199 / 0.0055 = 3.6181818...
  closeTo(even.totalFee / lopsided.totalFee, 3.618181818181818, 'ratio');
});

test('the same set costs more than twice as much in fees on crypto as on politics', () => {
  // crypto @0.50/0.45: 0.07*0.25 + 0.07*0.2475 = 0.0175 + 0.017325 = 0.034825
  const crypto = completeSetCost(
    [{ price: 0.5 }, { price: 0.45 }],
    venueTakerFeeFn('polymarket', { category: 'crypto' }),
  );
  closeTo(crypto.totalFee, 0.034825, 'crypto totalFee');
});

test('a geopolitics complete set carries exactly zero fee', () => {
  const out = completeSetCost(
    [{ price: 0.5 }, { price: 0.45 }],
    venueTakerFeeFn('polymarket', { category: 'geopolitics' }),
  );
  assert.equal(out.totalFee, 0);
  closeTo(out.allInCost, 0.95, 'allInCost equals grossCost when fee-free');
});

test('completeSetCost handles a multi-outcome (neg-risk) set of more than two legs', () => {
  const fee = venueTakerFeeFn('kalshi');
  const out = completeSetCost([{ price: 0.5 }, { price: 0.3 }, { price: 0.15 }], fee);
  // gross = 0.5 + 0.3 + 0.15 = 0.95
  closeTo(out.grossCost, 0.95, 'grossCost');
  // fees = 0.07*0.5*0.5 + 0.07*0.3*0.7 + 0.07*0.15*0.85
  //      = 0.0175 + 0.0147 + 0.0089250 = 0.0411250
  closeTo(out.totalFee, 0.041125, 'totalFee');
  closeTo(out.allInCost, 0.991125, 'allInCost');
});

test('completeSetCost defaults a leg side to BUY, the conservative direction', () => {
  const lim = venueTakerFeeFn('limitless');
  const defaulted = completeSetCost([{ price: 0.5 }, { price: 0.45 }], lim);
  const explicit = completeSetCost(
    [{ price: 0.5, side: 'BUY' }, { price: 0.45, side: 'BUY' }],
    lim,
  );
  closeTo(defaulted.totalFee, explicit.totalFee, 'default matches explicit BUY');
  // BUY is the dearer side at these prices, so defaulting can only OVERstate cost —
  // the safe direction. 0.0300*0.5 + 0.0300*0.45 = 0.015 + 0.0135 = 0.0285
  closeTo(defaulted.totalFee, 0.0285, 'buy-side fee');
});

test('completeSetCost requires at least two legs', () => {
  const fee = venueTakerFeeFn('kalshi');
  assert.throws(() => completeSetCost([], fee), /at least 2 legs/);
  assert.throws(() => completeSetCost([{ price: 0.5 }], fee), /at least 2 legs/);
  assert.throws(() => completeSetCost('nope', fee), /at least 2 legs/);
});

test('completeSetCost rejects a resolved or degenerate price of exactly 0 or 1', () => {
  // A leg at 0 or 1 is a settled market, not a tradeable one. Pricing it silently
  // would report a free complete set that cannot actually be bought.
  const fee = venueTakerFeeFn('kalshi');
  assert.throws(
    () => completeSetCost([{ price: 0 }, { price: 0.5 }], fee),
    /leg 0 price must be a finite number strictly between 0 and 1/,
  );
  assert.throws(
    () => completeSetCost([{ price: 0.5 }, { price: 1 }], fee),
    /leg 1 price must be a finite number strictly between 0 and 1/,
  );
});

test('completeSetCost rejects NaN, non-numeric and out-of-range leg prices, naming the leg', () => {
  const fee = venueTakerFeeFn('kalshi');
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '0.5', null, undefined, -0.1, 1.5]) {
    assert.throws(
      () => completeSetCost([{ price: 0.4 }, { price: bad }], fee),
      /leg 1 price must be a finite number strictly between 0 and 1/,
      `expected leg price ${String(bad)} to be rejected`,
    );
  }
});

test('completeSetCost rejects a malformed leg and an unrecognised side', () => {
  const fee = venueTakerFeeFn('kalshi');
  assert.throws(() => completeSetCost([{ price: 0.4 }, null], fee), /leg 1 must be an object/);
  assert.throws(
    () => completeSetCost([{ price: 0.4 }, { price: 0.5, side: 'long' }], fee),
    /leg 1 side must be 'BUY' or 'SELL'/,
  );
});

test('completeSetCost requires a callable fee function', () => {
  assert.throws(() => completeSetCost([{ price: 0.4 }, { price: 0.5 }], null), /feeFn must be a function/);
  assert.throws(() => completeSetCost([{ price: 0.4 }, { price: 0.5 }]), /feeFn must be a function/);
});

test('completeSetCost rejects a fee function returning a non-finite or negative fee', () => {
  // A broken adapter must not be able to fabricate a profitable-looking set.
  assert.throws(
    () => completeSetCost([{ price: 0.4 }, { price: 0.5 }], () => Number.NaN),
    /feeFn returned a non-finite or negative fee/,
  );
  assert.throws(
    () => completeSetCost([{ price: 0.4 }, { price: 0.5 }], () => -0.01),
    /feeFn returned a non-finite or negative fee/,
  );
});
