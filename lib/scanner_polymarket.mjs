/**
 * Polymarket live scanner — maintain books from the public market channel, price every
 * complete set on each update, and record what it found.
 *
 * **This module is read-only against the venue.** It holds no credentials and has no
 * code path that can place an order. That is a property of Phase 1, not an oversight.
 *
 * Transport facts, live-verified 2026-07-31 against
 * `wss://ws-subscriptions-clob.polymarket.com/ws/market` (see `docs/adapters.md`):
 *
 * - **Every data frame is a JSON ARRAY**, even when it carries a single message.
 * - `book` messages replace a token's whole ladder; `price_change` messages carry an
 *   array of per-asset level updates, where `side: 'BUY'` means the bid side and
 *   `'SELL'` the ask side, and a `size` of `0` is a cancellation.
 * - Prices, sizes and timestamps all arrive as **strings**.
 * - Ladder ordering is undocumented (live: bids ascend, asks descend), so top-of-book is
 *   found by scanning for max(bid)/min(ask) — never by array position.
 *
 * The one rule that governs pricing here: **a complete set is BOUGHT, so every leg is
 * priced at its ASK.** Reading bids would show a fat edge on a set that costs more than
 * $1 — on a wide book, the difference is the whole spread.
 */

import { detectOpportunity } from './arb.mjs';

/** The public market channel. No authentication required for any read here. */
export const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

/** Bid side, per the venue's `price_change` encoding. */
const SIDE_BUY = 'BUY';

/**
 * The subscribe payload the market channel expects.
 *
 * @param {ReadonlyArray<string>} tokenIds
 * @returns {{assets_ids: string[], type: string}}
 */
export function buildSubscribe(tokenIds) {
  return { assets_ids: [...tokenIds], type: 'market' };
}

/**
 * Parse one websocket frame into zero or more messages.
 *
 * Never throws. A scanner that dies on a single malformed frame stops measuring, which
 * is a worse outcome than skipping the frame — keepalives (`PING`/`PONG`) and junk both
 * yield an empty list.
 *
 * @param {string} text
 * @returns {Array<object>}
 */
export function parseFrame(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.filter((m) => m !== null && typeof m === 'object' && !Array.isArray(m));
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
 * In-memory order books, keyed by token id.
 *
 * Ladders are held as `Map<price, size>` so a `price_change` is a point update rather
 * than an array rewrite, and so a cancelled level is genuinely deleted instead of
 * lingering as a zero that later reads as tradeable size.
 *
 * @returns {{applyMessage: Function, top: Function, tokens: Function, size: number}}
 */
export function createBookStore() {
  /** @type {Map<string, {bids: Map<number, number>, asks: Map<number, number>, ts: number|null}>} */
  const books = new Map();

  const bookFor = (tokenId) => {
    let book = books.get(tokenId);
    if (!book) {
      book = { bids: new Map(), asks: new Map(), ts: null };
      books.set(tokenId, book);
    }
    return book;
  };

  const loadLevels = (levels) => {
    const out = new Map();
    if (!Array.isArray(levels)) return out;
    for (const level of levels) {
      const price = numOrNull(level?.price);
      const size = numOrNull(level?.size);
      // A level missing either half cannot be costed or sized against, so it is skipped
      // rather than defaulted.
      if (price === null || size === null || size <= 0) continue;
      out.set(price, size);
    }
    return out;
  };

  return {
    /**
     * Fold one parsed message into the store. Unmodelled message types are ignored.
     *
     * @param {object} msg
     */
    applyMessage(msg) {
      if (msg === null || typeof msg !== 'object') return;

      if (msg.event_type === 'book') {
        if (typeof msg.asset_id !== 'string') return;
        // A snapshot is the venue's complete current state. Replacing rather than
        // merging is load-bearing: merging would resurrect levels the venue has already
        // removed, and size a trade against liquidity that is gone.
        books.set(msg.asset_id, {
          bids: loadLevels(msg.bids),
          asks: loadLevels(msg.asks),
          ts: numOrNull(msg.timestamp),
        });
        return;
      }

      if (msg.event_type === 'price_change') {
        if (!Array.isArray(msg.price_changes)) return;
        const ts = numOrNull(msg.timestamp);
        for (const change of msg.price_changes) {
          if (change === null || typeof change !== 'object') continue;
          if (typeof change.asset_id !== 'string') continue;
          const price = numOrNull(change.price);
          const size = numOrNull(change.size);
          if (price === null || size === null) continue;

          const book = bookFor(change.asset_id);
          const side = change.side === SIDE_BUY ? book.bids : book.asks;
          // Size 0 is a cancellation. Keeping it would size against liquidity that has
          // already been pulled.
          if (size <= 0) side.delete(price);
          else side.set(price, size);
          if (ts !== null) book.ts = ts;
        }
      }
    },

    /**
     * Top of book for one token.
     *
     * @param {string} tokenId
     * @returns {{bestBid: number|null, bidSize: number|null, bestAsk: number|null,
     *            askSize: number|null, ts: number|null}|null} `null` if never quoted
     */
    top(tokenId) {
      const book = books.get(tokenId);
      if (!book) return null;

      let bestBid = null;
      let bidSize = null;
      for (const [price, size] of book.bids) {
        if (bestBid === null || price > bestBid) {
          bestBid = price;
          bidSize = size;
        }
      }

      let bestAsk = null;
      let askSize = null;
      for (const [price, size] of book.asks) {
        if (bestAsk === null || price < bestAsk) {
          bestAsk = price;
          askSize = size;
        }
      }

      return { bestBid, bidSize, bestAsk, askSize, ts: book.ts };
    },

    /** @returns {string[]} every token currently held */
    tokens() {
      return [...books.keys()];
    },

    /**
     * Forget every book.
     *
     * Called on reconnect. While disconnected the scanner misses `price_change`
     * cancellations, so a level pulled during the gap would otherwise survive in the
     * ladder and be read as the best ask — a price nobody is offering, which
     * UNDERSTATES cost and manufactures edge. The venue re-sends full snapshots on
     * subscribe, so discarding is free.
     */
    clear() {
      books.clear();
    },

    get size() {
      return books.size;
    },
  };
}

/**
 * The deduplicated token universe a batch of sets needs subscribed.
 *
 * @param {ReadonlyArray<{legs: ReadonlyArray<{tokenId: string}>}>} sets
 * @returns {string[]}
 */
export function tokensForSets(sets) {
  const tokens = new Set();
  for (const set of sets) {
    for (const leg of set.legs) tokens.add(leg.tokenId);
  }
  return [...tokens];
}

/**
 * Has the subscribed token universe changed?
 *
 * Order-insensitive, because discovery returns markets in whatever order the venue
 * paginated them and a reshuffle is not a rotation.
 *
 * This matters because of a venue trap: a `subscribe` sent on an ALREADY-OPEN socket is
 * reported to be a no-op, so a rotated-in token would silently stream nothing while the
 * scanner believed it was watching. The safe response to any rotation is therefore to
 * force a reconnect rather than to resubscribe — which is correct whether or not the
 * no-op behaviour still holds, so this does not depend on that claim staying true.
 *
 * @param {ReadonlyArray<string>} prev
 * @param {ReadonlyArray<string>} next
 * @returns {boolean}
 */
export function tokenSetChanged(prev, next) {
  if (prev.length !== next.length) return true;
  const seen = new Set(prev);
  for (const token of next) {
    if (!seen.has(token)) return true;
  }
  return false;
}

/**
 * Backoff for reconnect attempts: doubling, capped.
 *
 * @param {number} attempt 0-based
 * @param {{baseMs?: number, maxMs?: number}} [opts]
 * @returns {number} milliseconds to wait
 */
export function reconnectDelayMs(attempt, { baseMs = 1000, maxMs = 30_000 } = {}) {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new TypeError(`attempt must be a non-negative integer, got ${String(attempt)}`);
  }
  return Math.min(maxMs, baseMs * 2 ** attempt);
}

/**
 * Index sets by the tokens they contain.
 *
 * Without this the scanner rescans EVERY set on EVERY message, which is both quadratic
 * and actively misleading: a set whose own books have not moved gets re-evaluated
 * thousands of times and, because its book image keeps ageing while other tokens stream,
 * almost every re-evaluation lands as a stale-book skip. A 54-second live run produced
 * 617,667 such skips out of 635,516 rows. Rescanning only the sets a message actually
 * touched removes that flood at the source, because such a set has a fresh book by
 * construction.
 *
 * @param {ReadonlyArray<{legs: ReadonlyArray<{tokenId: string}>}>} sets
 * @returns {Map<string, Array<object>>}
 */
export function indexSetsByToken(sets) {
  const index = new Map();
  for (const set of sets) {
    for (const leg of set.legs) {
      let bucket = index.get(leg.tokenId);
      if (!bucket) {
        bucket = [];
        index.set(leg.tokenId, bucket);
      }
      // A token can appear twice in one set (both legs of a degenerate pair); index it
      // once so the set is not scanned twice per message.
      if (!bucket.includes(set)) bucket.push(set);
    }
  }
  return index;
}

/**
 * The distinct sets touched by a batch of token updates.
 *
 * @param {Map<string, Array<object>>} index from `indexSetsByToken`
 * @param {Iterable<string>} tokenIds
 * @returns {Array<object>}
 */
export function setsForTokens(index, tokenIds) {
  const touched = new Set();
  for (const tokenId of tokenIds) {
    const bucket = index.get(tokenId);
    if (bucket) for (const set of bucket) touched.add(set);
  }
  return [...touched];
}

/**
 * The token ids a parsed message reports on.
 *
 * @param {object} msg
 * @returns {string[]}
 */
export function tokensInMessage(msg) {
  if (msg === null || typeof msg !== 'object') return [];
  if (msg.event_type === 'book') {
    return typeof msg.asset_id === 'string' ? [msg.asset_id] : [];
  }
  if (msg.event_type === 'price_change' && Array.isArray(msg.price_changes)) {
    const out = [];
    for (const change of msg.price_changes) {
      if (typeof change?.asset_id === 'string') out.push(change.asset_id);
    }
    return out;
  }
  return [];
}

/**
 * Decide which scanned rows are worth writing.
 *
 * A clearing set is ALWAYS persisted — those are the events the whole phase exists to
 * count. Non-clearing sets are sampled per event key, because the measurement needs the
 * miss *distribution*, not every individual re-evaluation of the same verdict.
 *
 * `missSampleMs` of 0 means "persist every miss too" — useful for a short diagnostic
 * run, ruinous as a standing default (see `lib/config.mjs`).
 *
 * @param {{missSampleMs: number}} opts
 * @returns {{shouldPersist: (row: object, nowMs: number) => boolean}}
 */
export function createPersistPolicy({ missSampleMs }) {
  if (typeof missSampleMs !== 'number' || !Number.isFinite(missSampleMs) || missSampleMs < 0) {
    throw new TypeError(
      `missSampleMs must be a finite number >= 0, got ${String(missSampleMs)}`,
    );
  }
  /** @type {Map<string, number>} last persisted miss, per event key */
  const lastMiss = new Map();

  return {
    shouldPersist(row, nowMs) {
      if (row.clears) return true;
      const key = `${row.venue}:${row.eventKey}:${row.kind}`;
      const last = lastMiss.get(key);
      if (last !== undefined && nowMs - last < missSampleMs) return false;
      lastMiss.set(key, nowMs);
      return true;
    },
  };
}

/**
 * Price every set against current book state.
 *
 * A set is skipped entirely — not partially priced — when any leg is unquoted or has no
 * ask. Pricing the legs that happen to be available would compare a partial cost against
 * a $1 payout that requires every outcome.
 *
 * @param {{sets: ReadonlyArray<object>, store: object, cfg: object, nowMs: number,
 *          venue: string, feeFnFor: (row: object) => Function}} args
 *   `venue` and `feeFnFor` are INJECTED rather than imported. CLAUDE.md's adapter rule
 *   is that detection never branches on venue name, and a hardcoded adapter import is
 *   that branch in disguise — it is what made this function silently Polymarket-only.
 * @returns {Array<object>} one row per priced set, each carrying its per-leg detail
 */
export function scanSets({ sets, store, cfg, nowMs, venue, feeFnFor }) {
  if (typeof feeFnFor !== 'function') {
    throw new TypeError(`feeFnFor must be a function, got ${String(feeFnFor)}`);
  }
  if (typeof venue !== 'string' || venue === '') {
    throw new TypeError(`venue must be a non-empty string, got ${String(venue)}`);
  }
  const rows = [];

  for (const set of sets) {
    const legs = [];
    let complete = true;

    for (const leg of set.legs) {
      const top = store.top(leg.tokenId);
      // A complete set needs every outcome. One missing ask means no set.
      if (!top || top.bestAsk === null || top.askSize === null || top.ts === null) {
        complete = false;
        break;
      }
      legs.push({
        tokenId: leg.tokenId,
        outcome: leg.outcome,
        category: leg.category,
        // BUY side: a complete set is bought, so each leg costs its ASK.
        price: top.bestAsk,
        sizeShares: top.askSize,
        bookTs: top.ts,
      });
    }
    if (!complete) continue;

    // One fee function per set: every Polymarket leg of one event shares a category, and
    // building it here surfaces an unmapped category as a throw rather than a zero fee.
    const feeFn = feeFnFor(set.legs[0]);

    const detected = detectOpportunity({
      venue,
      eventKey: set.eventKey,
      kind: set.kind,
      legs,
      feeFn,
      cfg,
      nowMs,
    });

    rows.push({
      ...detected,
      legs: legs.map((l) => ({
        tokenId: l.tokenId,
        outcome: l.outcome,
        price: l.price,
        sizeShares: l.sizeShares,
        // Recorded per leg so a later fee-schedule correction can be re-applied to
        // history instead of invalidating it.
        feeUsd: detected.skipped ? null : feeFn(l.price),
      })),
    });
  }

  return rows;
}

/**
 * Write one scanned set and its legs.
 *
 * Wrapped in a transaction because a set row without its legs is unattributable — the
 * pair lands together or not at all.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} row a row from `scanSets`
 * @returns {number} the new `opportunities.id`
 */
export function persistOpportunity(db, row) {
  const insertOpp = db.prepare(
    `INSERT INTO opportunities
       (venue, event_key, ts, kind, leg_count, gross_cost, total_fee, net_edge,
        capacity_shares, capacity_usd, binding_leg, book_age_ms, detected_ms, skip_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertLeg = db.prepare(
    `INSERT INTO opportunity_legs
       (opportunity_id, token_id, outcome, price, size_shares, fee_usd)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  db.exec('BEGIN');
  try {
    const res = insertOpp.run(
      row.venue,
      row.eventKey,
      row.ts,
      row.kind,
      row.legCount,
      row.grossCost,
      row.totalFee,
      row.netEdge,
      row.capacityShares,
      row.capacityUsd,
      // TEXT column: a leg index and the literal 'notional' share it, so the index is
      // stringified rather than silently coerced.
      row.bindingLeg === null || row.bindingLeg === undefined ? null : String(row.bindingLeg),
      row.bookAgeMs,
      row.detectedMs ?? null,
      row.skipped ?? null,
    );
    const id = Number(res.lastInsertRowid);

    for (const leg of row.legs) {
      insertLeg.run(id, leg.tokenId, leg.outcome, leg.price, leg.sizeShares, leg.feeUsd);
    }

    db.exec('COMMIT');
    return id;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
