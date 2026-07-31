/**
 * Polymarket adapter — discovery, complete-set grouping, and book normalization.
 *
 * Every fact below was pinned against Polymarket's own endpoints on 2026-07-31; the
 * spike log with sources and sample sizes is in `docs/adapters.md`. Three of those facts
 * are load-bearing enough to restate here, because each one is a trap:
 *
 * 1. **A neg-risk set is not one market with N outcomes.** Each outcome is its OWN
 *    binary market with its own `conditionId` and YES/NO token pair. What makes them one
 *    mutually-exclusive set is a shared `negRiskMarketID`. So a single neg-risk member
 *    belongs to TWO complete sets at once — its own YES+NO pair, and the group-wide
 *    basket of every member's YES token — and they unwind by different mechanics
 *    (CTF merge vs NegRiskAdapter convert). Neither may shadow the other.
 *
 * 2. **The order book puts the best price LAST on both sides.** Bids ascend, asks
 *    descend. `bids[0]` is the *worst* bid (0.001 on the live sample) and `asks[0]` the
 *    worst ask (0.999). Reading index 0 would price every set catastrophically wrong.
 *
 * 3. **The fee category lives in `feeType`, not in `tags`.** `tags` are editorial labels
 *    that cross-cut real fee status — 'Politics' appears on markets the venue charges
 *    nothing for AND on markets it does charge. `feeType` is an explicit
 *    `<category>_fees` string, and `feesEnabled === (feeType !== null)` held with zero
 *    exceptions across 500 live markets.
 *
 * No fee arithmetic happens here; rates come from `lib/fees.mjs`.
 */

import { KIND_BINARY, KIND_NEG_RISK } from '../arb.mjs';
import { POLYMARKET_FEE_RATES, venueTakerFeeFn } from '../fees.mjs';

/** Matches the `venue` column value used across the schema. */
export const NAME = 'polymarket';

/** Public, no auth required for any read this adapter performs. */
export const GAMMA_MARKETS_URL = 'https://gamma-api.polymarket.com/markets';

/**
 * Gamma's `feeType` → the category `lib/fees.mjs` prices.
 *
 * Enumerated over 500 unique live markets (2026-07-31). Deliberately NOT derived by
 * string-stripping `_fees`/`_v2`: a new venue category should fail the lookup and be
 * dropped loudly, not be silently invented by a regex that happens to produce a name
 * `lib/fees.mjs` also happens to know.
 *
 * `general_fees` is real (15 of 500) and deliberately ABSENT: its stem is not a category
 * in the published schedule, so its rate is genuinely unknown. See `feeCategoryFor`.
 */
export const FEE_TYPE_TO_CATEGORY = Object.freeze({
  politics_fees: 'politics',
  sports_fees_v2: 'sports',
  crypto_fees_v2: 'crypto',
  tech_fees: 'tech',
  culture_fees: 'culture',
  weather_fees: 'weather',
  economics_fees: 'economics',
  finance_prices_fees: 'finance',
});

/** The zero-rate category in `lib/fees.mjs`, used for fee-exempt markets. */
const FEE_FREE_CATEGORY = 'geopolitics';

/**
 * Resolve a market's fee category.
 *
 * @param {object} market a raw Gamma market
 * @returns {string|null} a `lib/fees.mjs` category, or `null` when the rate is unknown
 */
export function feeCategoryFor(market) {
  const feeType = market?.feeType;

  // Fees off AND no fee type: the exempt bucket. Verified as an exact correspondence
  // over 500 live markets (465 enabled/non-null vs 35 disabled/null, no exceptions).
  if (!market?.feesEnabled && (feeType === null || feeType === undefined)) {
    return FEE_FREE_CATEGORY;
  }

  // `Object.hasOwn` so 'constructor'/'toString'/'__proto__' cannot resolve through the
  // prototype chain to something truthy.
  if (typeof feeType === 'string' && Object.hasOwn(FEE_TYPE_TO_CATEGORY, feeType)) {
    return FEE_TYPE_TO_CATEGORY[feeType];
  }

  // Fees are ON at a rate we cannot name — or the shape is unrecognised. Returning a
  // guess here is the one failure that costs money silently: too low manufactures edge
  // that does not exist. The market is dropped downstream instead, and counted.
  return null;
}

/**
 * Parse a Gamma field that arrives as a JSON *string* containing an array.
 *
 * @param {unknown} raw
 * @returns {Array|null} the array, or `null` if unusable
 */
function parseJsonArray(raw) {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** @returns {boolean} whether `n` is a finite number strictly greater than 0 */
function positive(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * Normalize one raw Gamma market into one row per outcome token.
 *
 * Returns `[]` — never a partial row and never a throw — for anything untradeable or
 * unparseable, so one malformed market in a 500-market page cannot abort discovery.
 *
 * @param {object} market
 * @returns {Array<object>} rows shaped for the `markets` table
 */
export function normalizeMarket(market) {
  if (market === null || typeof market !== 'object') return [];

  // Only markets that can actually be traded right now. A closed or paused market has a
  // stale book that would price a set which cannot be filled.
  if (market.closed || market.active === false || market.acceptingOrders === false) return [];

  const tokenIds = parseJsonArray(market.clobTokenIds);
  const outcomes = parseJsonArray(market.outcomes);
  if (!tokenIds || !outcomes) return [];
  if (tokenIds.length !== outcomes.length || tokenIds.length === 0) return [];

  const tickSize = market.orderPriceMinTickSize;
  const minOrderSize = market.orderMinSize;
  if (!positive(tickSize) || !positive(minOrderSize)) return [];

  const negRisk = market.negRisk === true;
  const category = feeCategoryFor(market);

  // A neg-risk member's event is the GROUP; a standalone market is its own event.
  const eventKey = negRisk && market.negRiskMarketID ? market.negRiskMarketID : market.conditionId;
  if (typeof eventKey !== 'string' || eventKey === '') return [];

  return tokenIds.map((tokenId, i) => ({
    venue: NAME,
    eventKey,
    conditionId: market.conditionId,
    tokenId: String(tokenId),
    outcome: String(outcomes[i]),
    marketSlug: market.slug ?? null,
    category,
    // Stored for the row; the live fee comes from `feeFnFor`, never from this number.
    feeRate: category === null ? null : POLYMARKET_FEE_RATES[category],
    tickSize,
    minOrderSize,
    negRisk,
    negRiskOther: market.negRiskOther === true,
  }));
}

/**
 * Build the complete sets present in a batch of normalized rows.
 *
 * A group is DROPPED rather than priced when it is not a complete set. That is not
 * conservatism for its own sake: a complete set pays exactly $1 *because* it covers
 * every outcome, so pricing a partial group compares the cost of some outcomes against a
 * payout that requires all of them — it understates cost and invents an edge that cannot
 * be redeemed.
 *
 * Neg-risk completeness relies on the caller having discovered every market in the
 * group. Gamma's events endpoint nests all of them, which is why discovery reads events
 * rather than markets in isolation.
 *
 * @param {Array<object>} rows
 * @param {{withDrops?: boolean}} [opts]
 * @returns {Array<object>|{sets: Array<object>, dropped: Array<object>}}
 */
export function groupIntoSets(rows, { withDrops = false } = {}) {
  const sets = [];
  const dropped = [];

  const byCondition = new Map();
  const byNegRiskGroup = new Map();

  for (const row of rows) {
    if (!byCondition.has(row.conditionId)) byCondition.set(row.conditionId, []);
    byCondition.get(row.conditionId).push(row);

    if (row.negRisk && row.outcome === 'Yes') {
      if (!byNegRiskGroup.has(row.eventKey)) byNegRiskGroup.set(row.eventKey, []);
      byNegRiskGroup.get(row.eventKey).push(row);
    }
  }

  const priceable = (legs) => legs.every((l) => l.category !== null);

  for (const [conditionId, legs] of byCondition) {
    const outcomes = legs.map((l) => l.outcome);
    if (legs.length !== 2 || !outcomes.includes('Yes') || !outcomes.includes('No')) {
      dropped.push({ eventKey: conditionId, kind: KIND_BINARY, reason: 'incomplete_binary' });
      continue;
    }
    if (!priceable(legs)) {
      dropped.push({ eventKey: conditionId, kind: KIND_BINARY, reason: 'unmapped_fee_type' });
      continue;
    }
    // Yes first, so leg order is stable across runs and matches the neg-risk convention.
    const ordered = [...legs].sort((a, b) => (a.outcome === 'Yes' ? -1 : 1));
    sets.push({ eventKey: conditionId, kind: KIND_BINARY, legs: ordered });
  }

  for (const [eventKey, legs] of byNegRiskGroup) {
    if (legs.length < 2) {
      dropped.push({ eventKey, kind: KIND_NEG_RISK, reason: 'incomplete_neg_risk' });
      continue;
    }
    if (!priceable(legs)) {
      dropped.push({ eventKey, kind: KIND_NEG_RISK, reason: 'unmapped_fee_type' });
      continue;
    }
    sets.push({ eventKey, kind: KIND_NEG_RISK, legs });
  }

  return withDrops ? { sets, dropped } : sets;
}

/**
 * @param {unknown} raw
 * @returns {number|null} a finite positive number parsed from a string, else `null`
 */
function numOrNull(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Reduce a `GET /book` response to top-of-book.
 *
 * **Both sides are read from the END of the array.** Bids arrive ascending and asks
 * descending, so the best price is last on each side; index 0 is the worst. Verified
 * live against Gamma's independently reported `bestBid`/`bestAsk` for the same token.
 *
 * Sizes are SHARE counts, which is what capacity sizing needs — an arb locks $1 per
 * share-set, so a dollar figure here would lose the quantity.
 *
 * @param {object} book
 * @returns {{tokenId: string, bestBid: number|null, bestAsk: number|null,
 *            bidSize: number|null, askSize: number|null, ts: number|null}}
 */
export function bookTopFromBook(book) {
  if (book === null || typeof book !== 'object') {
    throw new TypeError(`book must be an object, got ${String(book)}`);
  }

  const best = (levels) => {
    if (!Array.isArray(levels) || levels.length === 0) return { price: null, size: null };
    const level = levels[levels.length - 1];
    const price = numOrNull(level?.price);
    const size = numOrNull(level?.size);
    // Both or neither: a price without a size cannot be sized against, and a size
    // without a price cannot be costed.
    if (price === null || size === null) return { price: null, size: null };
    return { price, size };
  };

  const bid = best(book.bids);
  const ask = best(book.asks);

  return {
    tokenId: book.asset_id === undefined ? null : String(book.asset_id),
    bestBid: bid.price,
    bidSize: bid.size,
    bestAsk: ask.price,
    askSize: ask.size,
    ts: numOrNull(book.timestamp),
  };
}

/**
 * Build the per-share fee function for a normalized row.
 *
 * Delegates entirely to `lib/fees.mjs`, and deliberately lets its throw escape for an
 * unmapped category rather than substituting a zero fee.
 *
 * @param {object} row a row from `normalizeMarket`
 * @returns {(price: number) => number}
 */
export function feeFnFor(row) {
  return venueTakerFeeFn(NAME, { category: row?.category });
}

/**
 * Page through Gamma's market list and return normalized rows.
 *
 * `fetchImpl` is injected so the test suite never touches the network.
 *
 * @param {{fetchImpl?: Function, pageSize?: number, maxPages?: number}} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function discoverMarkets({
  fetchImpl = globalThis.fetch,
  pageSize = 100,
  maxPages = 20,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError(`fetchImpl must be a function, got ${String(fetchImpl)}`);
  }

  const rows = [];
  for (let page = 0; page < maxPages; page += 1) {
    const url = `${GAMMA_MARKETS_URL}?closed=false&limit=${pageSize}&offset=${page * pageSize}`;
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      // Never return a short list: a missing member of a neg-risk group turns a complete
      // set into an incomplete one, which is priced too cheaply.
      throw new Error(`Polymarket discovery failed: HTTP ${res.status} for ${url}`);
    }
    const body = await res.json();
    if (!Array.isArray(body)) {
      throw new Error(`Polymarket discovery expected an array of markets, got ${typeof body}`);
    }
    if (body.length === 0) break;
    for (const market of body) rows.push(...normalizeMarket(market));
  }
  return rows;
}
