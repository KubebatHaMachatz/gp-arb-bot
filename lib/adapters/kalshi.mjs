/**
 * Kalshi adapter — discovery, complete-set grouping, and book normalization.
 *
 * Facts pinned live 2026-07-31 against `api.elections.kalshi.com`; the spike log is in
 * `docs/adapters.md`. Three of them are load-bearing enough to restate:
 *
 * 1. **`mutually_exclusive` on the EVENT is the set flag** — explicit, unlike
 *    Polymarket's structural `negRiskMarketID`. The event nests every member market, so
 *    a group arrives whole or not at all and completeness is structural.
 *
 * 2. **The order book is BIDS-ONLY on both sides.** `orderbook_fp.yes_dollars` holds YES
 *    bids and `no_dollars` holds NO bids; there are no ask queues. An ask is the mirror
 *    of the opposite side's bid:
 *
 *        YES ask = 1 − (best NO bid),  and its size is that NO bid's size
 *        NO  ask = 1 − (best YES bid), and its size is that YES bid's size
 *
 *    The size half is the part that is easy to get backwards, and getting it backwards
 *    sizes each leg against the wrong queue. Verified live: a market with best NO bid
 *    0.954 × 1307 reported `yes_ask 0.0460` and `yes_ask_size_fp 1307`.
 *
 * 3. **Both ladders ASCEND**, so the best bid is the LAST element on each side — the
 *    same trap as Polymarket, and handled the same way, by scanning for the extreme
 *    rather than reading by position.
 *
 * Fees: a single rate (`0.07 · p · (1−p)`, side-independent) with **no maker rebate
 * anywhere in the schedule**, so unlike Polymarket there is no category to resolve.
 */

import { venueTakerFeeFn } from '../fees.mjs';

export { groupIntoSets } from '../sets.mjs';

/** Matches the `venue` column value used across the schema. */
export const NAME = 'kalshi';

/** Public: every read this adapter performs works unauthenticated. */
export const EVENTS_URL = 'https://api.elections.kalshi.com/trade-api/v2/events';

/**
 * The single category `lib/fees.mjs` prices Kalshi at.
 *
 * Kalshi's editorial `category` field ('World', 'Elections', 'Politics') is NOT a fee
 * bucket — the standard series all charge the same rate — so it is recorded for
 * reporting and never consulted for pricing.
 *
 * A handful of series carry `fee_multiplier: 0` and are genuinely free. That multiplier
 * lives on the SERIES object, not on the event or market, so it is not resolved here;
 * pricing those at the standard rate OVERSTATES their cost, which only ever costs a
 * missed opportunity. Understating would manufacture edge, so this is the safe direction
 * to be wrong in. Tracked as a ❓ in docs/adapters.md.
 */
export const FEE_CATEGORY = 'kalshi';

const ACTIVE_STATUS = 'active';

/**
 * Is this a price someone can actually be lifted at?
 *
 * Strictly inside (0, 1). An empty bid queue mirrors into an ask of exactly 1.00 — the
 * venue reports `yes_bid_dollars: '0.0000'` for a market nobody is bidding on, and
 * 1 − 0 = 1 — which is not an offer, it is the absence of one. Letting it through
 * reaches the pricing core as a degenerate leg and throws mid-crawl, taking down a scan
 * that should simply have skipped the market. Found live on the first real crawl.
 *
 * @param {number|null} price
 * @returns {boolean}
 */
function liftable(price) {
  return price !== null && price > 0 && price < 1;
}

/**
 * @param {unknown} raw
 * @returns {number|null} a finite number parsed from a string, else `null`
 */
function numOrNull(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Best (highest) bid on one of Kalshi's two bid queues.
 *
 * Scans for the maximum rather than reading the last element: the ladder does arrive
 * ascending, but nothing documents that, and a reordering would silently misprice.
 *
 * @param {Array<[string, string]>} levels `[price, size]` pairs, as strings
 * @returns {{price: number, size: number}|null}
 */
export function bestBid(levels) {
  if (!Array.isArray(levels)) return null;
  let best = null;
  for (const level of levels) {
    if (!Array.isArray(level)) continue;
    const price = numOrNull(level[0]);
    const size = numOrNull(level[1]);
    // A level missing either half cannot be costed or sized against.
    if (price === null || size === null || size <= 0) continue;
    if (best === null || price > best.price) best = { price, size };
  }
  return best;
}

/**
 * Reduce a bids-only orderbook to the two ASK prices a buyer actually pays.
 *
 * This is the whole Kalshi transform. A complete set is bought, so both legs are taken
 * at their ask — and on this venue an ask exists only as the mirror of the opposite
 * side's bid.
 *
 * @param {object} orderbook the `orderbook_fp` object
 * @returns {{yesAsk: number|null, yesAskSize: number|null,
 *            noAsk: number|null, noAskSize: number|null}}
 */
export function asksFromOrderbook(orderbook) {
  if (orderbook === null || typeof orderbook !== 'object') {
    throw new TypeError(`orderbook must be an object, got ${String(orderbook)}`);
  }
  const yesBid = bestBid(orderbook.yes_dollars);
  const noBid = bestBid(orderbook.no_dollars);

  // A NO bid at q is someone willing to sell YES at 1−q, for exactly that size; and
  // symmetrically a YES bid at p is a NO offered at 1−p.
  const yesAsk = noBid === null ? null : 1 - noBid.price;
  const noAsk = yesBid === null ? null : 1 - yesBid.price;

  return {
    yesAsk: liftable(yesAsk) ? yesAsk : null,
    yesAskSize: liftable(yesAsk) ? noBid.size : null,
    noAsk: liftable(noAsk) ? noAsk : null,
    noAskSize: liftable(noAsk) ? yesBid.size : null,
  };
}

/**
 * Top-of-book straight from a nested market object.
 *
 * Discovery returns `yes_ask_dollars` / `yes_bid_dollars` and their sizes already
 * derived, so a full crawl prices every market without a second call per ticker. Live
 * cross-check confirmed these agree with `asksFromOrderbook` exactly, including that
 * `yes_ask_size_fp` IS the NO-bid size.
 *
 * @param {object} market
 * @returns {{yesAsk: number|null, yesAskSize: number|null,
 *            noAsk: number|null, noAskSize: number|null, ts: number|null}}
 */
export function asksFromMarket(market) {
  if (market === null || typeof market !== 'object') {
    throw new TypeError(`market must be an object, got ${String(market)}`);
  }
  const yesAsk = numOrNull(market.yes_ask_dollars);
  const noAsk = numOrNull(market.no_ask_dollars);
  // `yes_ask_size_fp` is the size resting on the NO-bid queue, which is what a YES buyer
  // lifts. `yes_bid_size_fp` is what a NO buyer lifts. Swapping these sizes the legs
  // against the wrong queue while the prices still look right.
  const yesAskSize = numOrNull(market.yes_ask_size_fp);
  const noAskSize = numOrNull(market.yes_bid_size_fp);

  return {
    yesAsk: liftable(yesAsk) ? yesAsk : null,
    yesAskSize: liftable(yesAsk) ? yesAskSize : null,
    noAsk: liftable(noAsk) ? noAsk : null,
    noAskSize: liftable(noAsk) ? noAskSize : null,
    ts: numOrNull(market.last_updated_ts) ?? null,
  };
}

/**
 * Normalize one nested market into one row per outcome side.
 *
 * Returns `[]` — never a partial row, never a throw — for anything untradeable, so one
 * odd market in a crawl cannot abort discovery.
 *
 * @param {object} market
 * @param {{eventTicker?: string, mutuallyExclusive?: boolean, groupSize?: number|null,
 *          category?: string|null}} [ctx]
 * @returns {Array<object>} rows shaped for the `markets` table
 */
export function normalizeMarket(market, ctx = {}) {
  if (market === null || typeof market !== 'object') return [];
  if (market.status !== ACTIVE_STATUS) return [];

  const ticker = market.ticker;
  if (typeof ticker !== 'string' || ticker === '') return [];

  const negRisk = ctx.mutuallyExclusive === true;
  // A mutually-exclusive member belongs to the GROUP; a standalone market is its own set.
  const eventKey = negRisk ? ctx.eventTicker : ticker;
  if (typeof eventKey !== 'string' || eventKey === '') return [];

  // Kalshi has no token ids — a market plus a side identifies an outcome uniquely, and
  // the schema's UNIQUE(venue, token_id) needs one value per tradeable thing.
  const base = {
    venue: NAME,
    eventKey,
    conditionId: ticker,
    marketSlug: ticker,
    category: FEE_CATEGORY,
    feeRate: 0.07,
    tickSize: market.price_level_structure === 'linear_cent' ? 0.01 : 0.001,
    minOrderSize: 1,
    negRisk,
    negRiskOther: false,
    negRiskGroupSize: negRisk ? (ctx.groupSize ?? null) : null,
    venueCategory: ctx.category ?? null,
  };

  return [
    { ...base, tokenId: `${ticker}:YES`, outcome: 'Yes' },
    { ...base, tokenId: `${ticker}:NO`, outcome: 'No' },
  ];
}

/**
 * Normalize one event, stamping its members with the group's declared size.
 *
 * @param {object} event
 * @returns {Array<object>}
 */
export function normalizeEvent(event) {
  if (event === null || typeof event !== 'object') return [];
  const markets = Array.isArray(event.markets) ? event.markets : [];
  const mutuallyExclusive = event.mutually_exclusive === true;
  // Counted BEFORE filtering for tradeability, so a group with one closed outcome reads
  // as incomplete rather than quietly shrinking to fit the members that happen to be open.
  const groupSize = mutuallyExclusive ? markets.length : null;

  return markets.flatMap((market) =>
    normalizeMarket(market, {
      eventTicker: event.event_ticker,
      mutuallyExclusive,
      groupSize,
      category: event.category ?? null,
    }),
  );
}

/**
 * Build the per-share fee function for a row.
 *
 * Kalshi takes one rate for every standard series and is side-independent, so unlike
 * Polymarket there is no category to resolve and nothing that can fail to map.
 *
 * @returns {(price: number) => number}
 */
export function feeFnFor() {
  return venueTakerFeeFn(NAME);
}

/**
 * Page through the events list and return normalized rows.
 *
 * Reads EVENTS with nested markets for the same reason Polymarket's discovery does: a
 * mutually-exclusive group arrives whole, so a partial group can never be priced as
 * complete. Pagination is by opaque `cursor`, not by offset.
 *
 * **Throttled, and that is not optional.** The unauthenticated API rate-limits a rapid
 * crawl: paging without a delay returns HTTP 429 on the very second page, so an
 * unthrottled discovery does not merely run slowly, it fails outright. A 429 is retried
 * with backoff rather than thrown, because throwing on a transient limit would abandon a
 * whole crawl — but a persistent one still throws, since a short list would turn a
 * complete set into an incomplete one and price it too cheaply.
 *
 * @param {{fetchImpl?: Function, pageSize?: number, maxPages?: number,
 *          pageDelayMs?: number, maxRetries?: number, sleep?: Function,
 *          now?: Function, onEvent?: Function}} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function discoverMarkets({
  fetchImpl = globalThis.fetch,
  pageSize = 200,
  maxPages = 50,
  pageDelayMs = 300,
  maxRetries = 4,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  onEvent = null,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError(`fetchImpl must be a function, got ${String(fetchImpl)}`);
  }

  const rows = [];
  // Cursors already requested. A server that echoes one must not be followed: the echo
  // page would be CONSUMED before any after-the-fact check could stop it, and duplicated
  // rows give a binary group four legs instead of two — which `groupIntoSets` then drops
  // as incomplete. A cursor loop would therefore not inflate the crawl, it would silently
  // zero it out.
  const seenCursors = new Set(['']);
  const seenTokens = new Set();
  let cursor = '';
  for (let page = 0; page < maxPages; page += 1) {
    const url =
      `${EVENTS_URL}?status=open&with_nested_markets=true&limit=${pageSize}` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');

    // Space the pages out. Measured live: without this, page 2 is a 429.
    if (page > 0 && pageDelayMs > 0) await sleep(pageDelayMs);

    let res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    for (let retry = 0; res.status === 429 && retry < maxRetries; retry += 1) {
      await sleep(pageDelayMs * 2 ** (retry + 1));
      res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    }

    if (!res.ok) {
      throw new Error(`Kalshi discovery failed: HTTP ${res.status} for ${url}`);
    }
    const body = await res.json();
    if (body === null || typeof body !== 'object' || !Array.isArray(body.events)) {
      throw new Error('Kalshi discovery expected an object with an events array');
    }
    if (body.events.length === 0) break;
    // Stamp each row with when ITS page arrived, not when the crawl finished. A full
    // crawl takes tens of seconds, so a row from page 1 really is that stale by the time
    // page 40 lands — and Kalshi publishes no book-freshness field of its own
    // (`updated_time` is the market record's mtime, observed a month old on live data).
    // Per-page stamping is the only honest age available, and it lets the freshness gate
    // do its job instead of reading ~0 for everything.
    const fetchedAtMs = now();
    for (const event of body.events) {
      for (const row of normalizeEvent(event)) {
        // Deduped by token id, which is what actually protects the crawl. A cursor echo
        // is only detectable once it has been seen twice, by which point the repeat page
        // has already arrived — and a duplicated row gives a binary group FOUR legs
        // instead of two, which groupIntoSets drops as incomplete. So a loop would
        // silently zero the crawl out rather than inflate it. Deduping is robust to any
        // cause, not just this one.
        if (seenTokens.has(row.tokenId)) continue;
        seenTokens.add(row.tokenId);
        rows.push({ ...row, fetchedAtMs });
      }
      // Hook for the scanner: top-of-book lives on the raw nested market objects, and
      // re-fetching them per ticker would multiply an already-slow crawl.
      if (onEvent) onEvent(event, fetchedAtMs);
    }

    // Stop BEFORE requesting a cursor already used, so a repeated one is never fetched.
    if (!body.cursor || seenCursors.has(body.cursor)) break;
    seenCursors.add(body.cursor);
    cursor = body.cursor;
  }
  return rows;
}
