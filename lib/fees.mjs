/**
 * Taker fee models for every supported venue.
 *
 * This is the most consequential pure module in the repo. Every detection threshold
 * downstream is `1 − grossCost − totalFee`, so an understated fee here does not produce
 * a slightly-off number — it manufactures arbitrage that does not exist and fires real
 * orders at a loss. Two rules follow from that:
 *
 *   1. **Nothing defaults to free.** An unknown category or venue throws. Silently
 *      pricing an unmapped market at zero fee is the single most expensive failure this
 *      module could have.
 *   2. **Where a fee is a curve, it stays a curve.** No convenient scalar stands in for
 *      Limitless's real schedule.
 *
 * ## The two fee SHAPES, which are not interchangeable
 *
 * - **Polymarket and Kalshi** charge `rate × p × (1 − p)` **per share**. Symmetric about
 *   0.50 and decaying toward both extremes, so a complete set on a lopsided market is
 *   dramatically cheaper than one at even odds (see `docs/adapters.md`). That is why the
 *   detection threshold is a function of the leg prices and never a flat constant.
 * - **Limitless** charges a **rate on notional**, so the per-share fee is `rate(p) × p`,
 *   and the rate itself is a hand-tabulated curve that differs by trade DIRECTION and
 *   never decays to zero (it holds a ~0.40% floor where the others approach nothing).
 *
 * Conflating those two shapes is the exact error class `ANALYSIS.md` documents.
 *
 * All rates verified 2026-07-31 — see `docs/adapters.md` § Fee schedules for sources.
 */

/** Polymarket taker rate by market category. Takers only; makers pay zero. */
export const POLYMARKET_FEE_RATES = Object.freeze({
  crypto: 0.07,
  sports: 0.05,
  economics: 0.05,
  culture: 0.05,
  weather: 0.05,
  other: 0.05,
  politics: 0.04,
  finance: 0.04,
  tech: 0.04,
  mentions: 0.04,
  // Genuinely fee-free, not "unmapped". This is where taker arbitrage still exists
  // cleanly, and therefore where the competition concentrates.
  geopolitics: 0,
});

/** Kalshi's taker rate. Side-independent: the NO fee at `1−p` equals the YES fee at `p`. */
export const KALSHI_FEE_RATE = 0.07;

/** Limitless BUY curve: `[price, rateOnNotional]`, strictly ascending in price. */
export const LIMITLESS_BUY_CURVE = Object.freeze([
  [0.01, 0.03], [0.5, 0.03], [0.55, 0.0252], [0.6, 0.0213], [0.65, 0.018],
  [0.7, 0.0151], [0.75, 0.0126], [0.8, 0.0105], [0.85, 0.0085], [0.9, 0.0068],
  [0.95, 0.0053], [0.99, 0.0042], [0.999, 0.004],
].map((pair) => Object.freeze(pair)));

/** Limitless SELL curve — peaks at the midpoint, NOT a mirror of the BUY curve. */
export const LIMITLESS_SELL_CURVE = Object.freeze([
  [0.01, 0.0042], [0.05, 0.006], [0.1, 0.0078], [0.2, 0.0111], [0.3, 0.0132],
  [0.4, 0.0144], [0.5, 0.015], [0.6, 0.0144], [0.7, 0.0132], [0.8, 0.0111],
  [0.9, 0.0078], [0.95, 0.006], [0.99, 0.0045], [0.999, 0.0042],
].map((pair) => Object.freeze(pair)));

const SIDES = Object.freeze(['BUY', 'SELL']);

/**
 * @param {unknown} price
 * @returns {number} the validated price
 * @throws {TypeError} unless `price` is a finite number in `[0, 1]`
 */
function assertPrice(price) {
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0 || price > 1) {
    throw new TypeError(`price must be a finite number in [0, 1], got ${String(price)}`);
  }
  return price;
}

/**
 * @param {unknown} side
 * @returns {string} the validated side
 * @throws {TypeError} unless `side` is exactly `'BUY'` or `'SELL'`
 */
function assertSide(side) {
  if (side !== 'BUY' && side !== 'SELL') {
    throw new TypeError(`side must be 'BUY' or 'SELL', got ${String(side)}`);
  }
  return side;
}

/**
 * Resolve a category name to its verified rate.
 *
 * Looked up with `Object.hasOwn` rather than plain property access so that
 * `'constructor'`, `'toString'` and friends cannot resolve through the prototype chain
 * to a function — which would multiply into `NaN` and silently poison every downstream
 * comparison instead of failing.
 *
 * @param {unknown} category
 * @returns {number}
 * @throws {TypeError} on any unmapped category — never a zero-fee fallback
 */
function polymarketRateFor(category) {
  const key = typeof category === 'string' ? category.trim().toLowerCase() : '';
  if (!Object.hasOwn(POLYMARKET_FEE_RATES, key)) {
    throw new TypeError(
      `unknown Polymarket category ${JSON.stringify(String(category))} — ` +
        'refusing to assume a zero fee, which would manufacture phantom arbitrage. ' +
        `Known: ${Object.keys(POLYMARKET_FEE_RATES).join(', ')}`,
    );
  }
  return POLYMARKET_FEE_RATES[key];
}

/**
 * The `rate × p × (1 − p)` per-share fee shared by Polymarket and Kalshi.
 *
 * Single implementation on purpose: this is the formula that decides whether a trade is
 * profitable, and a second copy that drifts from this one would understate a fee in
 * exactly one code path — the kind of divergence tests only catch if they happen to
 * probe the price where the two disagree.
 *
 * @param {number} rate
 * @param {number} price
 * @returns {number}
 */
function quadraticPerShareFee(rate, price) {
  assertPrice(price);
  return rate * price * (1 - price);
}

/**
 * Polymarket taker fee, in dollars per share.
 *
 * @param {number} price in `[0, 1]`
 * @param {string} category one of `POLYMARKET_FEE_RATES`
 * @returns {number}
 */
export function polymarketTakerFee(price, category) {
  const rate = polymarketRateFor(category);
  return quadraticPerShareFee(rate, price);
}

/**
 * Kalshi taker fee, in dollars per share. No `side` parameter: a NO buy at `1−p` costs
 * `0.07·(1−p)·p`, algebraically identical to the YES fee at `p`.
 *
 * @param {number} price in `[0, 1]`
 * @returns {number}
 */
export function kalshiTakerFee(price) {
  return quadraticPerShareFee(KALSHI_FEE_RATE, price);
}

/**
 * Linear interpolation over a `[x, y]` table, clamped flat outside its ends.
 *
 * @param {ReadonlyArray<readonly [number, number]>} curve strictly ascending in x
 * @param {number} x
 * @returns {number}
 */
function interpolateClamped(curve, x) {
  const first = curve[0];
  const last = curve[curve.length - 1];
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];

  // Safe: x is strictly inside the table's range, so this terminates before the end.
  let i = 1;
  while (curve[i][0] < x) i += 1;

  const [x0, y0] = curve[i - 1];
  const [x1, y1] = curve[i];
  return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
}

/**
 * Limitless taker fee, in dollars per share.
 *
 * The tabulated value is a **rate on notional**, so the per-share fee is `rate × price`
 * — structurally unlike the `p·(1−p)` venues. `side` is required rather than defaulted:
 * the two curves differ by 2× at the midpoint and even invert their ordering by p=0.90,
 * so guessing would be wrong in an unpredictable direction.
 *
 * @param {number} price in `[0, 1]`
 * @param {'BUY'|'SELL'} side
 * @returns {number}
 */
export function limitlessTakerFee(price, side) {
  assertSide(side);
  assertPrice(price);
  const curve = side === 'BUY' ? LIMITLESS_BUY_CURVE : LIMITLESS_SELL_CURVE;
  return interpolateClamped(curve, price) * price;
}

/**
 * Build a `(price, side) => feePerShare` closure for a venue, so callers never branch on
 * venue name.
 *
 * Venue-specific requirements are validated **here**, when the closure is built — not on
 * the first priced leg. A scanner that discovers a missing category mid-detection has
 * already lost the opportunity it was pricing.
 *
 * @param {string} venue `'polymarket'` | `'kalshi'` | `'limitless'`
 * @param {{category?: string}} [opts] `category` is required for Polymarket
 * @returns {(price: number, side?: 'BUY'|'SELL') => number}
 * @throws {TypeError} on an unknown venue, or a missing/unknown Polymarket category
 */
export function venueTakerFeeFn(venue, opts = {}) {
  const key = typeof venue === 'string' ? venue.trim().toLowerCase() : '';

  if (key === 'polymarket') {
    // Resolve eagerly so a bad category fails at construction, then reuse the SAME
    // formula as polymarketTakerFee rather than re-deriving it here.
    const rate = polymarketRateFor(opts.category);
    return (price) => quadraticPerShareFee(rate, price);
  }
  if (key === 'kalshi') return (price) => kalshiTakerFee(price);
  if (key === 'limitless') return (price, side) => limitlessTakerFee(price, side);

  throw new TypeError(
    `unknown venue ${JSON.stringify(String(venue))} — known: polymarket, kalshi, limitless`,
  );
}

/**
 * Price a complete set: every outcome of one mutually-exclusive event.
 *
 * @param {ReadonlyArray<{price: number, side?: 'BUY'|'SELL'}>} legs at least 2
 * @param {(price: number, side: 'BUY'|'SELL') => number} feeFn from `venueTakerFeeFn`
 * @returns {{grossCost: number, totalFee: number, allInCost: number}}
 * @throws {TypeError} on a malformed set, a degenerate leg price, or a bad fee
 */
export function completeSetCost(legs, feeFn) {
  if (!Array.isArray(legs) || legs.length < 2) {
    throw new TypeError(
      `a complete set needs at least 2 legs, got ${Array.isArray(legs) ? legs.length : String(legs)}`,
    );
  }
  if (typeof feeFn !== 'function') {
    throw new TypeError(`feeFn must be a function, got ${String(feeFn)}`);
  }

  let grossCost = 0;
  let totalFee = 0;

  for (let i = 0; i < legs.length; i += 1) {
    const leg = legs[i];
    if (leg === null || typeof leg !== 'object') {
      throw new TypeError(`leg ${i} must be an object, got ${String(leg)}`);
    }

    const { price } = leg;
    // Strictly inside (0, 1): a leg at exactly 0 or 1 is a resolved market, and pricing
    // it would report a "free" complete set that cannot actually be bought.
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0 || price >= 1) {
      throw new TypeError(
        `leg ${i} price must be a finite number strictly between 0 and 1, got ${String(price)}`,
      );
    }

    // Default BUY: complete-set arbitrage buys every leg, and on the one venue where
    // side matters BUY is the dearer side at the midpoint — so a defaulted side can
    // only ever OVERstate cost, which is the safe direction to be wrong in.
    const side = leg.side === undefined ? 'BUY' : leg.side;
    if (!SIDES.includes(side)) {
      throw new TypeError(`leg ${i} side must be 'BUY' or 'SELL', got ${String(leg.side)}`);
    }

    const fee = feeFn(price, side);
    if (typeof fee !== 'number' || !Number.isFinite(fee) || fee < 0) {
      // A broken adapter must not be able to fabricate a profitable-looking set.
      throw new TypeError(
        `feeFn returned a non-finite or negative fee for leg ${i}: ${String(fee)}`,
      );
    }

    grossCost += price;
    totalFee += fee;
  }

  return { grossCost, totalFee, allInCost: grossCost + totalFee };
}
