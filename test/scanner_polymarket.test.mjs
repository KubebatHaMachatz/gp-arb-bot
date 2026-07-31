import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../lib/db.mjs';
import { normalizeEvent } from '../lib/adapters/polymarket.mjs';
import {
  WS_URL,
  buildSubscribe,
  createBookStore,
  createPersistPolicy,
  indexSetsByToken,
  parseFrame,
  persistOpportunity,
  scanSets,
  setsForTokens,
  tokensForSets,
  tokensInMessage,
} from '../lib/scanner_polymarket.mjs';

const EPS = 1e-12;
const closeTo = (a, e, m) =>
  assert.ok(Math.abs(a - e) < EPS, `${m ?? 'value'}: expected ${e} +/- ${EPS}, got ${a}`);

const scratch = () => mkdtempSync(join(tmpdir(), 'gp-arb-scan-'));

const CFG = Object.freeze({
  bookStaleMs: 750,
  minNetEdge: 0.005,
  depthSafetyFactor: 0.5,
  maxSetSizeUsd: 250,
});

const YES = 'tok-yes';
const NO = 'tok-no';

/**
 * A real `book` frame, captured live 2026-07-31 from
 * wss://ws-subscriptions-clob.polymarket.com/ws/market and trimmed to a few levels.
 * Ordering preserved exactly: bids ASCEND, asks DESCEND. Note the frame is an ARRAY even
 * when it carries a single message, and `event_type` sits near the END of the object.
 */
const REAL_BOOK_FRAME = JSON.stringify([
  {
    market: '0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75',
    asset_id: '54533043819946592547517511176940999955633860128497669742211153063842200957669',
    timestamp: '1785497753434',
    hash: 'f39e739c8b4666f02c7ad9ad7ac40566141e6943',
    bids: [
      { price: '0.001', size: '2756598' },
      { price: '0.192', size: '5547.95' },
      { price: '0.193', size: '313.88' },
    ],
    asks: [
      { price: '0.999', size: '6149778.01' },
      { price: '0.195', size: '6862.72' },
      { price: '0.194', size: '34453.8' },
    ],
    tick_size: '0.001',
    event_type: 'book',
    last_trade_price: '0.193',
  },
]);

/** A real `price_change` frame, same session. Carries best_bid/best_ask per asset. */
const REAL_PRICE_CHANGE_FRAME = JSON.stringify({
  market: '0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75',
  price_changes: [
    {
      asset_id: '54533043819946592547517511176940999955633860128497669742211153063842200957669',
      price: '0.194',
      size: '34447.8',
      side: 'SELL',
      hash: '2bb8fd99a37650570b34324bf927407c5a7f7cb8',
      best_bid: '0.193',
      best_ask: '0.194',
    },
  ],
  timestamp: '1785497759210',
  event_type: 'price_change',
});

/** Helpers build INPUTS only. */
function bookMsg(assetId, { bids = [], asks = [], ts = 1000 } = {}) {
  return { event_type: 'book', asset_id: assetId, timestamp: String(ts), bids, asks };
}
function changeMsg(assetId, changes, ts = 1000) {
  return {
    event_type: 'price_change',
    timestamp: String(ts),
    price_changes: changes.map((c) => ({ asset_id: assetId, ...c })),
  };
}
function binarySet(legs) {
  return [{ eventKey: 'evt-1', kind: 'binary', legs }];
}
const leg = (tokenId, outcome, category = 'politics') => ({
  venue: 'polymarket',
  eventKey: 'evt-1',
  conditionId: 'cond-1',
  tokenId,
  outcome,
  category,
  feeRate: category === 'politics' ? 0.04 : 0,
  negRisk: false,
});

// ── parseFrame ──────────────────────────────────────────────────────────────

test('parseFrame unwraps the ARRAY frame the venue actually sends', () => {
  // Live-verified: every data frame is a JSON array, even carrying one message.
  const msgs = parseFrame(REAL_BOOK_FRAME);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].event_type, 'book');
});

test('parseFrame also accepts a bare object frame', () => {
  const msgs = parseFrame(REAL_PRICE_CHANGE_FRAME);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].event_type, 'price_change');
});

test('parseFrame returns several messages from one multi-message frame', () => {
  const frame = JSON.stringify([bookMsg('a'), bookMsg('b'), bookMsg('c')]);
  assert.equal(parseFrame(frame).length, 3);
});

test('parseFrame ignores keepalive and unparseable frames without throwing', () => {
  // A scanner that dies on one malformed frame stops measuring; it must skip and carry on.
  for (const junk of ['PING', 'PONG', '', 'not json', '{"unclosed":', 'null', '123', '"str"']) {
    assert.deepEqual(parseFrame(junk), [], JSON.stringify(junk));
  }
});

test('parseFrame drops non-object entries inside an otherwise valid array', () => {
  const frame = JSON.stringify([bookMsg('a'), null, 42, 'x', bookMsg('b')]);
  assert.equal(parseFrame(frame).length, 2);
});

// ── createBookStore ─────────────────────────────────────────────────────────

test('the store ingests a real book frame and reads top-of-book correctly', () => {
  const store = createBookStore();
  for (const m of parseFrame(REAL_BOOK_FRAME)) store.applyMessage(m);
  const top = store.top(
    '54533043819946592547517511176940999955633860128497669742211153063842200957669',
  );
  // best bid is the MAX (0.193), best ask the MIN (0.194) — not the array positions
  closeTo(top.bestBid, 0.193, 'bestBid');
  closeTo(top.bestAsk, 0.194, 'bestAsk');
  closeTo(top.bidSize, 313.88, 'bidSize');
  closeTo(top.askSize, 34453.8, 'askSize');
  assert.equal(top.ts, 1785497753434);
});

test('the store finds the extremes regardless of level ordering', () => {
  const store = createBookStore();
  store.applyMessage(
    bookMsg(YES, {
      bids: [{ price: '0.40', size: '10' }, { price: '0.10', size: '99' }, { price: '0.25', size: '50' }],
      asks: [{ price: '0.90', size: '7' }, { price: '0.45', size: '20' }, { price: '0.60', size: '3' }],
    }),
  );
  const top = store.top(YES);
  closeTo(top.bestBid, 0.4, 'bestBid is the max');
  closeTo(top.bidSize, 10, 'and its size');
  closeTo(top.bestAsk, 0.45, 'bestAsk is the min');
  closeTo(top.askSize, 20, 'and its size');
});

test('a book snapshot REPLACES the ladder rather than merging into it', () => {
  // A snapshot is the venue's full current state; merging would resurrect levels the
  // venue has already removed and size against liquidity that is gone.
  const store = createBookStore();
  store.applyMessage(bookMsg(YES, { asks: [{ price: '0.30', size: '100' }] }));
  store.applyMessage(bookMsg(YES, { asks: [{ price: '0.55', size: '10' }], ts: 2000 }));
  const top = store.top(YES);
  closeTo(top.bestAsk, 0.55, 'old 0.30 level is gone');
  assert.equal(top.ts, 2000);
});

test('a price_change updates a level in place and moves the top', () => {
  const store = createBookStore();
  store.applyMessage(
    bookMsg(YES, {
      bids: [{ price: '0.40', size: '10' }],
      asks: [{ price: '0.60', size: '5' }],
    }),
  );
  store.applyMessage(changeMsg(YES, [{ price: '0.50', size: '77', side: 'SELL' }], 1500));
  const top = store.top(YES);
  closeTo(top.bestAsk, 0.5, 'new tighter ask');
  closeTo(top.askSize, 77, 'its size');
  closeTo(top.bestBid, 0.4, 'bid side untouched');
  assert.equal(top.ts, 1500, 'freshness advances with the delta');
});

test('a price_change with size 0 REMOVES the level', () => {
  // Zero size is a cancellation. Keeping it would size a trade against liquidity that
  // has already been pulled.
  const store = createBookStore();
  store.applyMessage(
    bookMsg(YES, { asks: [{ price: '0.50', size: '10' }, { price: '0.60', size: '20' }] }),
  );
  store.applyMessage(changeMsg(YES, [{ price: '0.50', size: '0', side: 'SELL' }]));
  closeTo(store.top(YES).bestAsk, 0.6, 'falls back to the next ask');
});

test('a price_change routes BUY to bids and SELL to asks', () => {
  const store = createBookStore();
  store.applyMessage(
    changeMsg(YES, [
      { price: '0.30', size: '11', side: 'BUY' },
      { price: '0.70', size: '22', side: 'SELL' },
    ]),
  );
  const top = store.top(YES);
  closeTo(top.bestBid, 0.3, 'BUY became a bid');
  closeTo(top.bidSize, 11, 'bid size');
  closeTo(top.bestAsk, 0.7, 'SELL became an ask');
  closeTo(top.askSize, 22, 'ask size');
});

test('the store ignores message types it does not model', () => {
  const store = createBookStore();
  store.applyMessage(bookMsg(YES, { asks: [{ price: '0.5', size: '1' }] }));
  store.applyMessage({ event_type: 'last_trade_price', asset_id: YES, price: '0.9' });
  store.applyMessage({ event_type: 'tick_size_change', asset_id: YES, new_tick_size: '0.01' });
  store.applyMessage({ no_event_type: true });
  store.applyMessage(null);
  closeTo(store.top(YES).bestAsk, 0.5, 'untouched by unmodelled messages');
});

test('the store reports an unknown token as absent rather than inventing a price', () => {
  const store = createBookStore();
  assert.equal(store.top('never-seen'), null);
  assert.equal(store.size, 0);
});

test('the store skips levels whose price or size will not parse', () => {
  const store = createBookStore();
  store.applyMessage(
    bookMsg(YES, {
      asks: [{ price: 'abc', size: '1' }, { price: '0.5', size: 'xyz' }, { price: '0.6', size: '3' }],
    }),
  );
  const top = store.top(YES);
  closeTo(top.bestAsk, 0.6, 'only the usable level survives');
});

test('a side with no usable levels reports null, not zero', () => {
  const store = createBookStore();
  store.applyMessage(bookMsg(YES, { bids: [], asks: [{ price: '0.5', size: '2' }] }));
  const top = store.top(YES);
  assert.equal(top.bestBid, null);
  assert.equal(top.bidSize, null);
  closeTo(top.bestAsk, 0.5, 'ask still read');
});

test('the store exposes the tokens it is tracking', () => {
  const store = createBookStore();
  assert.deepEqual(store.tokens(), []);
  store.applyMessage(bookMsg(YES, { asks: [{ price: '0.5', size: '1' }] }));
  store.applyMessage(changeMsg(NO, [{ price: '0.4', size: '2', side: 'BUY' }]));
  assert.deepEqual(store.tokens().sort(), [NO, YES].sort());
  assert.equal(store.size, 2);
});

test('the store ignores malformed book and price_change payloads', () => {
  const store = createBookStore();
  store.applyMessage({ event_type: 'book', asset_id: 42, bids: [], asks: [] });
  store.applyMessage({ event_type: 'price_change' }); // no price_changes array
  store.applyMessage({ event_type: 'price_change', price_changes: 'nope' });
  store.applyMessage({ event_type: 'price_change', price_changes: [null, 7, 'x'] });
  store.applyMessage({ event_type: 'price_change', price_changes: [{ price: '0.5', size: '1' }] });
  store.applyMessage({
    event_type: 'price_change',
    price_changes: [{ asset_id: YES, price: 'abc', size: '1', side: 'SELL' }],
  });
  assert.equal(store.size, 0, 'nothing usable was recorded');
});

test('a price_change with no timestamp leaves the existing freshness untouched', () => {
  const store = createBookStore();
  store.applyMessage(bookMsg(YES, { asks: [{ price: '0.5', size: '1' }], ts: 5000 }));
  store.applyMessage({
    event_type: 'price_change',
    price_changes: [{ asset_id: YES, price: '0.4', size: '2', side: 'SELL' }],
  });
  assert.equal(store.top(YES).ts, 5000);
});

test('a book snapshot drops levels quoted at zero size', () => {
  const store = createBookStore();
  store.applyMessage(
    bookMsg(YES, { asks: [{ price: '0.40', size: '0' }, { price: '0.50', size: '3' }] }),
  );
  closeTo(store.top(YES).bestAsk, 0.5, 'the zero-size level is not tradeable');
});

test('a book snapshot with no side arrays yields an empty book, not a crash', () => {
  const store = createBookStore();
  store.applyMessage({ event_type: 'book', asset_id: YES, timestamp: '1' });
  const top = store.top(YES);
  assert.equal(top.bestBid, null);
  assert.equal(top.bestAsk, null);
});

// ── tokensForSets ───────────────────────────────────────────────────────────

test('tokensForSets returns the deduplicated token universe to subscribe', () => {
  const sets = [
    { eventKey: 'a', kind: 'binary', legs: [leg(YES, 'Yes'), leg(NO, 'No')] },
    { eventKey: 'b', kind: 'neg_risk', legs: [leg(YES, 'Yes'), leg('tok-3', 'Yes')] },
  ];
  assert.deepEqual(tokensForSets(sets).sort(), [NO, 'tok-3', YES].sort());
});

// ── scanSets ────────────────────────────────────────────────────────────────

test('scanSets prices a complete set from live book state', () => {
  const store = createBookStore();
  store.applyMessage(bookMsg(YES, { asks: [{ price: '0.50', size: '400' }], ts: 1_000_000 }));
  store.applyMessage(bookMsg(NO, { asks: [{ price: '0.45', size: '600' }], ts: 1_000_000 }));

  const rows = scanSets({
    sets: binarySet([leg(YES, 'Yes'), leg(NO, 'No')]),
    store,
    cfg: CFG,
    nowMs: 1_000_500,
  });
  assert.equal(rows.length, 1);
  const row = rows[0];
  // gross 0.95; fees 0.04*0.5*0.5 + 0.04*0.45*0.55 = 0.0199; net 0.0301
  closeTo(row.grossCost, 0.95, 'grossCost');
  closeTo(row.totalFee, 0.0199, 'totalFee');
  closeTo(row.netEdge, 0.0301, 'netEdge');
  // capacity: min(400,600) * 0.5 = 200 shares
  closeTo(row.capacityShares, 200, 'capacityShares');
  assert.equal(row.clears, true);
  assert.equal(row.bookAgeMs, 500);
  assert.equal(row.venue, 'polymarket');
});

test('scanSets BUYS, so it must price the ASK side and never the bid', () => {
  // The single most dangerous confusion in this module. This book has a wide spread:
  // pricing the bids would show a 25c "edge" on a set that actually costs 1.15.
  const store = createBookStore();
  store.applyMessage(
    bookMsg(YES, {
      bids: [{ price: '0.40', size: '999' }],
      asks: [{ price: '0.60', size: '400' }],
      ts: 1_000_000,
    }),
  );
  store.applyMessage(
    bookMsg(NO, {
      bids: [{ price: '0.35', size: '999' }],
      asks: [{ price: '0.55', size: '600' }],
      ts: 1_000_000,
    }),
  );

  const [row] = scanSets({
    sets: binarySet([leg(YES, 'Yes'), leg(NO, 'No')]),
    store,
    cfg: CFG,
    nowMs: 1_000_100,
  });
  // asks: 0.60 + 0.55 = 1.15 gross, fees 0.0096 + 0.0099 = 0.0195, net -0.1695
  closeTo(row.grossCost, 1.15, 'gross is the ASK sum');
  closeTo(row.netEdge, -0.1695, 'and the edge is negative');
  assert.equal(row.clears, false);
  // bids would have summed to 0.75 and shown a fat positive edge
  assert.notEqual(row.grossCost, 0.75);
});

test('scanSets records a sub-threshold set rather than discarding it', () => {
  const store = createBookStore();
  store.applyMessage(bookMsg(YES, { asks: [{ price: '0.60', size: '10' }], ts: 1_000_000 }));
  store.applyMessage(bookMsg(NO, { asks: [{ price: '0.55', size: '10' }], ts: 1_000_000 }));
  const [row] = scanSets({
    sets: binarySet([leg(YES, 'Yes'), leg(NO, 'No')]),
    store,
    cfg: CFG,
    nowMs: 1_000_100,
  });
  assert.equal(row.clears, false);
  assert.ok(row.netEdge < 0, 'the miss is measured, not hidden');
});

test('scanSets applies the freshness gate through detectOpportunity', () => {
  const store = createBookStore();
  store.applyMessage(bookMsg(YES, { asks: [{ price: '0.50', size: '400' }], ts: 1_000_000 }));
  store.applyMessage(bookMsg(NO, { asks: [{ price: '0.45', size: '600' }], ts: 1_000_000 }));
  const [row] = scanSets({
    sets: binarySet([leg(YES, 'Yes'), leg(NO, 'No')]),
    store,
    cfg: CFG,
    nowMs: 1_002_000, // 2s old, past the 750ms gate
  });
  assert.equal(row.skipped, 'stale_book');
  assert.equal(row.netEdge, null);
  assert.equal(row.clears, false);
});

test('scanSets skips a set whose legs are not all quoted yet', () => {
  // Startup, or a token that has gone one-sided. Pricing the legs we happen to have
  // would compare a partial cost against a $1 payout requiring every outcome.
  const store = createBookStore();
  store.applyMessage(bookMsg(YES, { asks: [{ price: '0.50', size: '400' }], ts: 1_000_000 }));
  const rows = scanSets({
    sets: binarySet([leg(YES, 'Yes'), leg(NO, 'No')]),
    store,
    cfg: CFG,
    nowMs: 1_000_100,
  });
  assert.deepEqual(rows, []);
});

test('scanSets skips a leg quoted with no ASK at all', () => {
  const store = createBookStore();
  store.applyMessage(bookMsg(YES, { asks: [{ price: '0.50', size: '400' }], ts: 1_000_000 }));
  store.applyMessage(bookMsg(NO, { bids: [{ price: '0.40', size: '600' }], ts: 1_000_000 }));
  assert.deepEqual(
    scanSets({ sets: binarySet([leg(YES, 'Yes'), leg(NO, 'No')]), store, cfg: CFG, nowMs: 1_000_100 }),
    [],
  );
});

test('scanSets prices a three-leg neg-risk set', () => {
  const store = createBookStore();
  store.applyMessage(bookMsg('a', { asks: [{ price: '0.50', size: '100' }], ts: 1_000_000 }));
  store.applyMessage(bookMsg('b', { asks: [{ price: '0.30', size: '100' }], ts: 1_000_000 }));
  store.applyMessage(bookMsg('c', { asks: [{ price: '0.15', size: '100' }], ts: 1_000_000 }));
  const [row] = scanSets({
    sets: [
      {
        eventKey: 'grp',
        kind: 'neg_risk',
        legs: [leg('a', 'Yes', 'geopolitics'), leg('b', 'Yes', 'geopolitics'), leg('c', 'Yes', 'geopolitics')],
      },
    ],
    store,
    cfg: CFG,
    nowMs: 1_000_100,
  });
  assert.equal(row.kind, 'neg_risk');
  assert.equal(row.legCount, 3);
  // fee-free: gross 0.95, net 0.05
  closeTo(row.grossCost, 0.95, 'grossCost');
  assert.equal(row.totalFee, 0);
  closeTo(row.netEdge, 0.05, 'netEdge');
});

test('scanSets carries the per-leg detail needed to persist the set', () => {
  const store = createBookStore();
  store.applyMessage(bookMsg(YES, { asks: [{ price: '0.50', size: '400' }], ts: 1_000_000 }));
  store.applyMessage(bookMsg(NO, { asks: [{ price: '0.45', size: '600' }], ts: 1_000_000 }));
  const [row] = scanSets({
    sets: binarySet([leg(YES, 'Yes'), leg(NO, 'No')]),
    store,
    cfg: CFG,
    nowMs: 1_000_100,
  });
  assert.equal(row.legs.length, 2);
  assert.equal(row.legs[0].tokenId, YES);
  closeTo(row.legs[0].price, 0.5, 'leg price is the ask');
  closeTo(row.legs[0].sizeShares, 400, 'leg size is the ask size');
  // 0.04*0.5*0.5 = 0.01
  closeTo(row.legs[0].feeUsd, 0.01, 'per-leg fee');
});

test('scanSets surfaces an unmapped category as a throw, never a zero fee', () => {
  const store = createBookStore();
  store.applyMessage(bookMsg(YES, { asks: [{ price: '0.50', size: '400' }], ts: 1_000_000 }));
  store.applyMessage(bookMsg(NO, { asks: [{ price: '0.45', size: '600' }], ts: 1_000_000 }));
  assert.throws(
    () =>
      scanSets({
        sets: binarySet([{ ...leg(YES, 'Yes'), category: null }, leg(NO, 'No')]),
        store,
        cfg: CFG,
        nowMs: 1_000_100,
      }),
    /unknown Polymarket category/,
  );
});

// ── persistOpportunity ──────────────────────────────────────────────────────

test('persistOpportunity round-trips a set into the real schema', () => {
  const dir = scratch();
  try {
    const db = openDb(join(dir, 'a.db'));
    const store = createBookStore();
    store.applyMessage(bookMsg(YES, { asks: [{ price: '0.50', size: '400' }], ts: 1_000_000 }));
    store.applyMessage(bookMsg(NO, { asks: [{ price: '0.45', size: '600' }], ts: 1_000_000 }));
    const [row] = scanSets({
      sets: binarySet([leg(YES, 'Yes'), leg(NO, 'No')]),
      store,
      cfg: CFG,
      nowMs: 1_000_100,
    });

    const id = persistOpportunity(db, row);
    assert.ok(Number.isInteger(id) && id > 0);

    const saved = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(id);
    assert.equal(saved.venue, 'polymarket');
    assert.equal(saved.event_key, 'evt-1');
    assert.equal(saved.kind, 'binary');
    assert.equal(saved.leg_count, 2);
    closeTo(saved.net_edge, 0.0301, 'net_edge');
    assert.equal(saved.binding_leg, '0');
    assert.equal(saved.skip_reason, null);
    assert.equal(saved.book_age_ms, 100);

    const legs = db
      .prepare('SELECT * FROM opportunity_legs WHERE opportunity_id = ? ORDER BY id')
      .all(id);
    assert.equal(legs.length, 2);
    assert.equal(legs[0].token_id, YES);
    closeTo(legs[0].price, 0.5, 'leg price');
    closeTo(legs[0].size_shares, 400, 'leg size');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistOpportunity stores a skipped set with its reason and no edge numbers', () => {
  const dir = scratch();
  try {
    const db = openDb(join(dir, 'a.db'));
    const store = createBookStore();
    store.applyMessage(bookMsg(YES, { asks: [{ price: '0.50', size: '400' }], ts: 1_000_000 }));
    store.applyMessage(bookMsg(NO, { asks: [{ price: '0.45', size: '600' }], ts: 1_000_000 }));
    const [row] = scanSets({
      sets: binarySet([leg(YES, 'Yes'), leg(NO, 'No')]),
      store,
      cfg: CFG,
      nowMs: 1_005_000,
    });
    const id = persistOpportunity(db, row);
    const saved = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(id);
    assert.equal(saved.skip_reason, 'stale_book');
    assert.equal(saved.net_edge, null);
    assert.equal(saved.book_age_ms, 5000);
    // legs are still written, so a skip can be attributed to specific tokens later
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM opportunity_legs WHERE opportunity_id = ?').get(id).n,
      2,
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistOpportunity writes the set and its legs atomically', () => {
  // A row without its legs is unattributable; the pair must land together or not at all.
  const dir = scratch();
  try {
    const db = openDb(join(dir, 'a.db'));
    const bad = {
      venue: 'polymarket',
      eventKey: 'evt-1',
      kind: 'binary',
      ts: 1,
      legCount: 2,
      grossCost: 0.9,
      totalFee: 0.01,
      netEdge: 0.09,
      capacityShares: 1,
      capacityUsd: 1,
      bindingLeg: 0,
      bookAgeMs: 1,
      skipped: null,
      // a leg with a non-persistable price
      legs: [{ tokenId: 'a', outcome: 'Yes', price: {}, sizeShares: 1, feeUsd: 0 }],
    };
    assert.throws(() => persistOpportunity(db, bad));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM opportunities').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM opportunity_legs').get().n, 0);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── subscription wiring ─────────────────────────────────────────────────────

test('buildSubscribe produces the documented market-channel payload', () => {
  assert.deepEqual(buildSubscribe([YES, NO]), { assets_ids: [YES, NO], type: 'market' });
});

test('the websocket URL is the public market channel', () => {
  assert.equal(WS_URL, 'wss://ws-subscriptions-clob.polymarket.com/ws/market');
});

// ── end-to-end against the adapter's own output ─────────────────────────────

test('an adapter-produced set prices end to end from a real book frame', () => {
  // Guards the seam: if the adapter changed its row shape, or the scanner read a
  // different field, this fails here rather than in a live run.
  const event = {
    id: '1',
    negRisk: false,
    markets: [
      {
        conditionId: 'cond-x',
        clobTokenIds: `["${YES}", "${NO}"]`,
        outcomes: '["Yes", "No"]',
        negRisk: false,
        feeType: 'politics_fees',
        feesEnabled: true,
        orderMinSize: 5,
        orderPriceMinTickSize: 0.01,
        slug: 'x',
        acceptingOrders: true,
        closed: false,
        active: true,
      },
    ],
  };
  const rows = normalizeEvent(event);
  const sets = [{ eventKey: 'cond-x', kind: 'binary', legs: rows }];
  const store = createBookStore();
  store.applyMessage(bookMsg(YES, { asks: [{ price: '0.50', size: '400' }], ts: 1_000_000 }));
  store.applyMessage(bookMsg(NO, { asks: [{ price: '0.45', size: '600' }], ts: 1_000_000 }));
  const [row] = scanSets({ sets, store, cfg: CFG, nowMs: 1_000_100 });
  closeTo(row.netEdge, 0.0301, 'netEdge from adapter rows');
});


// ── incremental rescanning ──────────────────────────────────────────────────

test('tokensInMessage reports the tokens a book or price_change touches', () => {
  assert.deepEqual(tokensInMessage(bookMsg(YES, {})), [YES]);
  assert.deepEqual(
    tokensInMessage(changeMsg(YES, [{ price: '0.5', size: '1', side: 'SELL' }])),
    [YES],
  );
  assert.deepEqual(
    tokensInMessage({
      event_type: 'price_change',
      price_changes: [{ asset_id: 'a' }, { asset_id: 'b' }, { nope: 1 }],
    }),
    ['a', 'b'],
  );
});

test('tokensInMessage reports nothing for messages it does not model', () => {
  for (const msg of [
    null,
    'x',
    { event_type: 'last_trade_price', asset_id: YES },
    { event_type: 'book', asset_id: 42 },
    { event_type: 'price_change', price_changes: 'nope' },
  ]) {
    assert.deepEqual(tokensInMessage(msg), [], JSON.stringify(msg));
  }
});

test('indexSetsByToken maps each token to the sets that contain it', () => {
  const a = { eventKey: 'a', kind: 'binary', legs: [leg(YES, 'Yes'), leg(NO, 'No')] };
  const b = { eventKey: 'b', kind: 'neg_risk', legs: [leg(YES, 'Yes'), leg('tok-3', 'Yes')] };
  const index = indexSetsByToken([a, b]);
  assert.deepEqual(index.get(YES), [a, b]);
  assert.deepEqual(index.get(NO), [a]);
  assert.deepEqual(index.get('tok-3'), [b]);
});

test('indexSetsByToken lists a set once even if a token repeats within it', () => {
  const dup = { eventKey: 'd', kind: 'binary', legs: [leg(YES, 'Yes'), leg(YES, 'No')] };
  assert.equal(indexSetsByToken([dup]).get(YES).length, 1);
});

test('setsForTokens returns only the DISTINCT sets a message batch touched', () => {
  // The fix for a real live failure: rescanning all 3630 sets on every message produced
  // 635,516 rows in 54 seconds, 97% of them redundant stale-book skips, because a set
  // whose own books had not moved was re-evaluated until its image aged out.
  const a = { eventKey: 'a', kind: 'binary', legs: [leg(YES, 'Yes'), leg(NO, 'No')] };
  const b = { eventKey: 'b', kind: 'neg_risk', legs: [leg(YES, 'Yes'), leg('tok-3', 'Yes')] };
  const c = { eventKey: 'c', kind: 'binary', legs: [leg('tok-9', 'Yes'), leg('tok-8', 'No')] };
  const index = indexSetsByToken([a, b, c]);

  assert.deepEqual(setsForTokens(index, [YES]), [a, b], 'both sets holding YES');
  assert.deepEqual(setsForTokens(index, [NO]), [a]);
  assert.deepEqual(setsForTokens(index, [YES, NO]), [a, b], 'a is not duplicated');
  assert.deepEqual(setsForTokens(index, ['unknown']), [], 'untracked token touches nothing');
  assert.deepEqual(setsForTokens(index, []), []);
});

// ── persist policy ──────────────────────────────────────────────────────────

test('the persist policy ALWAYS writes a clearing set', () => {
  const policy = createPersistPolicy({ missSampleMs: 300_000 });
  const clearing = { venue: 'polymarket', eventKey: 'e', kind: 'binary', clears: true };
  for (let i = 0; i < 5; i += 1) {
    assert.equal(policy.shouldPersist(clearing, 1000 + i), true, `call ${i}`);
  }
});

test('the persist policy SAMPLES non-clearing sets per event key', () => {
  const policy = createPersistPolicy({ missSampleMs: 300_000 });
  const miss = { venue: 'polymarket', eventKey: 'e', kind: 'binary', clears: false };
  assert.equal(policy.shouldPersist(miss, 1_000_000), true, 'first miss is recorded');
  assert.equal(policy.shouldPersist(miss, 1_000_001), false, 'the next is not');
  assert.equal(policy.shouldPersist(miss, 1_299_999), false, 'still inside the window');
  assert.equal(policy.shouldPersist(miss, 1_300_000), true, 'exactly at the window it samples again');
  assert.equal(policy.shouldPersist(miss, 1_300_001), false, 'and the window restarts');
});

test('the persist policy samples each event key independently', () => {
  const policy = createPersistPolicy({ missSampleMs: 300_000 });
  const miss = (eventKey, kind = 'binary') => ({ venue: 'polymarket', eventKey, kind, clears: false });
  assert.equal(policy.shouldPersist(miss('a'), 1000), true);
  assert.equal(policy.shouldPersist(miss('b'), 1000), true, 'a different event is not suppressed');
  assert.equal(policy.shouldPersist(miss('a'), 1001), false);
  // the two kinds of set over one event key are tracked apart, since they are different trades
  assert.equal(policy.shouldPersist(miss('a', 'neg_risk'), 1001), true);
});

test('a missSampleMs of 0 records every miss — a diagnostic setting, not a default', () => {
  const policy = createPersistPolicy({ missSampleMs: 0 });
  const miss = { venue: 'polymarket', eventKey: 'e', kind: 'binary', clears: false };
  assert.equal(policy.shouldPersist(miss, 1000), true);
  assert.equal(policy.shouldPersist(miss, 1000), true);
});

test('createPersistPolicy rejects an unusable sampling window', () => {
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '300', null, undefined]) {
    assert.throws(
      () => createPersistPolicy({ missSampleMs: bad }),
      /missSampleMs must be a finite number >= 0/,
      String(bad),
    );
  }
});

test('the policy collapses a flood of repeated stale-book skips', () => {
  // The shape of the live failure, in miniature: the same set re-evaluated 1000 times
  // inside one sampling window must yield exactly one row.
  const policy = createPersistPolicy({ missSampleMs: 300_000 });
  const skip = {
    venue: 'polymarket',
    eventKey: 'e',
    kind: 'binary',
    clears: false,
    skipped: 'stale_book',
  };
  let written = 0;
  for (let i = 0; i < 1000; i += 1) {
    if (policy.shouldPersist(skip, 1_000_000 + i)) written += 1;
  }
  assert.equal(written, 1);
});
