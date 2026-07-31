/**
 * Complete-set arbitrage detection.
 *
 * The trade: buy every outcome of one mutually-exclusive event on one venue for less
 * than $1, then merge the complete set back into collateral for exactly $1. Exactly one
 * outcome resolves YES, so the payoff is $1 per share-set regardless of which — and
 * because both legs live on the same venue with the same resolution source, there is no
 * settlement risk and the merge is immediate.
 *
 * Two things this module refuses to do, because both are how a detector lies:
 *
 *   1. **It never re-implements fee math.** Every fee comes from `lib/fees.mjs`. A
 *      second copy of `rate·p·(1−p)` living here would be free to drift.
 *   2. **It never hides a miss.** A negative edge is recorded as a negative number, not
 *      swallowed — the record of near-misses is what makes edge decay visible later, and
 *      a detector that only logs its wins cannot be evaluated at all.
 *
 * The one number that matters is `netEdge = 1 − grossCost − totalFee`. A set can be
 * gross-profitable and fee-negative at the same time: YES 0.50 + NO 0.49 on a crypto
 * market looks like a free penny and is a 2.5¢ loss once both legs pay the real taker
 * fee. That inversion is the entire reason this module exists.
 */

import { completeSetCost } from './fees.mjs';

/** Two-outcome market: YES + NO. Unwound with a CTF `mergePositions` call. */
export const KIND_BINARY = 'binary';

/** Multi-outcome (neg-risk) set. Unwound via the NegRiskAdapter `convert` call. */
export const KIND_NEG_RISK = 'neg_risk';

const KINDS = Object.freeze([KIND_BINARY, KIND_NEG_RISK]);

/** A complete set always pays exactly this, whichever outcome resolves. */
const COMPLETE_SET_PAYOUT = 1;

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 * @throws {TypeError} unless `value` is a finite number strictly greater than 0
 */
function assertPositive(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a finite number greater than 0, got ${String(value)}`);
  }
  return value;
}

/**
 * Price a complete set and net it against the $1 payout.
 *
 * @param {ReadonlyArray<{price: number, side?: string}>} legs
 * @param {Function} feeFn
 * @param {string} kind
 * @returns {{kind: string, grossCost: number, totalFee: number, allInCost: number, netEdge: number}}
 */
function edgeFor(legs, feeFn, kind) {
  const { grossCost, totalFee, allInCost } = completeSetCost(legs, feeFn);
  return {
    kind,
    grossCost,
    totalFee,
    allInCost,
    // May be negative. That is a measurement, not an error.
    netEdge: COMPLETE_SET_PAYOUT - allInCost,
  };
}

/**
 * Edge on a two-outcome market (YES + NO < $1).
 *
 * @param {{legs: ReadonlyArray<{price: number, side?: string}>, feeFn: Function}} args
 * @returns {{kind: string, grossCost: number, totalFee: number, allInCost: number, netEdge: number}}
 */
export function binaryComplementEdge({ legs, feeFn }) {
  if (!Array.isArray(legs) || legs.length !== 2) {
    throw new TypeError(
      `binary complement needs exactly 2 legs, got ${Array.isArray(legs) ? legs.length : String(legs)}`,
    );
  }
  return edgeFor(legs, feeFn, KIND_BINARY);
}

/**
 * Edge on a multi-outcome (neg-risk) set — the category that produced $29M of the
 * $39.6M measured on Polymarket.
 *
 * The arithmetic is identical to the binary case (a complete set still pays exactly $1);
 * the kind is carried separately because the mechanics to unwind differ and because the
 * two are worth reporting apart.
 *
 * @param {{legs: ReadonlyArray<{price: number, side?: string}>, feeFn: Function}} args
 * @returns {{kind: string, grossCost: number, totalFee: number, allInCost: number, netEdge: number}}
 */
export function negRiskSetEdge({ legs, feeFn }) {
  return edgeFor(legs, feeFn, KIND_NEG_RISK);
}

/**
 * Is this edge worth acting on?
 *
 * Fee- and price-aware by construction: `netEdge` has already netted the real per-leg
 * fees, which is why a flat threshold works *here* and would not work on a gross number.
 *
 * No epsilon is applied. Accumulated float error on these sums is ~1e-16 while the
 * configured floor is bounded well above 0 (`GPA_MIN_NET_EDGE` lives in `(0, 1]`, and a
 * realistic value is 0.005), so a tolerance would only add a knob that can be set wrong.
 *
 * @param {{netEdge: number|null, skipped?: string|null}} result
 * @param {{minNetEdge: number}} opts
 * @returns {boolean}
 */
export function clearsThreshold(result, { minNetEdge }) {
  if (typeof minNetEdge !== 'number' || !Number.isFinite(minNetEdge) || minNetEdge <= 0 || minNetEdge > 1) {
    throw new TypeError(
      `minNetEdge must be a finite number in (0, 1], got ${String(minNetEdge)}`,
    );
  }
  if (result.skipped) return false;
  return result.netEdge >= minNetEdge;
}

/**
 * Size a set against the book.
 *
 * **Share-constrained, never dollar-constrained.** An arb locks $1 per share-*set*, so
 * the binding leg is the one with fewest SHARES. Taking `min(dollars)` instead picks
 * whichever leg is cheapest and authorises a size the thin leg cannot fill: legs at
 * 0.90×100 ($90) and 0.05×500 ($25) disagree about which is thinner, and the dollar
 * reading oversizes by 5×.
 *
 * `bindingLeg` reports WHICH constraint bound — a leg index, or `'notional'` when the
 * USD cap did. That distinction is the operator's signal: a thin book means wait, a
 * bound cap means add capital.
 *
 * @param {{legs: ReadonlyArray<{sizeShares: number}>, safetyFactor: number,
 *          maxSetSizeUsd: number, allInCostPerSet: number}} args
 * @returns {{capacityShares: number, capacityUsd: number, bindingLeg: number|'notional'}}
 */
export function setCapacity({ legs, safetyFactor, maxSetSizeUsd, allInCostPerSet }) {
  if (!Array.isArray(legs) || legs.length < 2) {
    throw new TypeError(
      `a complete set needs at least 2 legs, got ${Array.isArray(legs) ? legs.length : String(legs)}`,
    );
  }
  if (
    typeof safetyFactor !== 'number' ||
    !Number.isFinite(safetyFactor) ||
    safetyFactor <= 0 ||
    safetyFactor > 1
  ) {
    // Exactly 0 is invalid, matching `GPA_DEPTH_SAFETY_FACTOR`: it is not "disabled",
    // it silently sizes every trade to nothing.
    throw new TypeError(
      `safetyFactor must be a finite number in (0, 1], got ${String(safetyFactor)}`,
    );
  }
  assertPositive(maxSetSizeUsd, 'maxSetSizeUsd');
  assertPositive(allInCostPerSet, 'allInCostPerSet');

  let thinnestIndex = 0;
  let thinnestShares = Number.POSITIVE_INFINITY;

  for (let i = 0; i < legs.length; i += 1) {
    const shares = legs[i]?.sizeShares;
    if (typeof shares !== 'number' || !Number.isFinite(shares) || shares <= 0) {
      throw new TypeError(
        `leg ${i} sizeShares must be a finite number greater than 0, got ${String(shares)}`,
      );
    }
    // Strictly less than, so the FIRST of several tied legs is reported.
    if (shares < thinnestShares) {
      thinnestShares = shares;
      thinnestIndex = i;
    }
  }

  const fromBook = thinnestShares * safetyFactor;

  if (fromBook * allInCostPerSet > maxSetSizeUsd) {
    const capped = maxSetSizeUsd / allInCostPerSet;
    return {
      capacityShares: capped,
      capacityUsd: capped * allInCostPerSet,
      bindingLeg: 'notional',
    };
  }

  return {
    capacityShares: fromBook,
    capacityUsd: fromBook * allInCostPerSet,
    bindingLeg: thinnestIndex,
  };
}

/**
 * The composed entry point a scanner calls per event: freshness-gate, price, size, and
 * threshold in one pass, returning a row shaped for the `opportunities` table.
 *
 * The freshness gate comes FIRST and short-circuits everything else. A displayed
 * crossing is disproportionately one somebody is already taking or cancelling, so a
 * stale book must not become a number — the row records `skipped: 'stale_book'` and the
 * observed age, with every edge field left `null`. Recording the skip (rather than
 * dropping the event) is what makes the gate's own cost measurable.
 *
 * Age is taken from the OLDEST leg: one fresh leg cannot vouch for a stale one, and the
 * trade needs every book.
 *
 * @param {{venue: string, eventKey: string, kind: string,
 *          legs: ReadonlyArray<object>, feeFn: Function, cfg: object,
 *          nowMs: number, bookTs?: number}} args
 * @returns {object} a row for `opportunities`
 */
export function detectOpportunity({ venue, eventKey, kind, legs, feeFn, cfg, nowMs, bookTs }) {
  if (cfg === null || typeof cfg !== 'object') {
    throw new TypeError(`cfg must be an object, got ${String(cfg)}`);
  }
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new TypeError(`nowMs must be a finite number, got ${String(nowMs)}`);
  }
  if (!KINDS.includes(kind)) {
    throw new TypeError(`kind must be 'binary' or 'neg_risk', got ${String(kind)}`);
  }
  if (!Array.isArray(legs) || legs.length < 2) {
    throw new TypeError(
      `a complete set needs at least 2 legs, got ${Array.isArray(legs) ? legs.length : String(legs)}`,
    );
  }

  let oldestTs = Number.POSITIVE_INFINITY;
  for (let i = 0; i < legs.length; i += 1) {
    const ts = legs[i]?.bookTs === undefined ? bookTs : legs[i].bookTs;
    if (typeof ts !== 'number' || !Number.isFinite(ts)) {
      throw new TypeError(`leg ${i} bookTs must be a finite number, got ${String(ts)}`);
    }
    if (ts < oldestTs) oldestTs = ts;
  }

  // Left unclamped: a negative age means the clock is skewed against the venue's, which
  // is worth seeing in the data rather than rounding away to a healthy-looking zero.
  const bookAgeMs = nowMs - oldestTs;

  const base = {
    venue,
    eventKey,
    kind,
    ts: nowMs,
    legCount: legs.length,
    bookAgeMs,
  };

  if (bookAgeMs > cfg.bookStaleMs) {
    return {
      ...base,
      skipped: 'stale_book',
      grossCost: null,
      totalFee: null,
      netEdge: null,
      capacityShares: null,
      capacityUsd: null,
      bindingLeg: null,
      clears: false,
    };
  }

  const edge = kind === KIND_BINARY
    ? binaryComplementEdge({ legs, feeFn })
    : negRiskSetEdge({ legs, feeFn });

  const capacity = setCapacity({
    legs,
    safetyFactor: cfg.depthSafetyFactor,
    maxSetSizeUsd: cfg.maxSetSizeUsd,
    allInCostPerSet: edge.allInCost,
  });

  return {
    ...base,
    skipped: null,
    grossCost: edge.grossCost,
    totalFee: edge.totalFee,
    netEdge: edge.netEdge,
    capacityShares: capacity.capacityShares,
    capacityUsd: capacity.capacityUsd,
    bindingLeg: capacity.bindingLeg,
    clears: clearsThreshold(edge, { minNetEdge: cfg.minNetEdge }),
  };
}
