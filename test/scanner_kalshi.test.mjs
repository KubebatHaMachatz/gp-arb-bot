import { test } from 'node:test';
import assert from 'node:assert/strict';

import { asksFromMarket } from '../lib/adapters/kalshi.mjs';
import { createPollStore, topsFromEvent } from '../lib/scanner_kalshi.mjs';

const EPS = 1e-12;
const closeTo = (a, e, m) =>
  assert.ok(Math.abs(a - e) < EPS, `${m ?? 'value'}: expected ${e} +/- ${EPS}, got ${a}`);

const MARKET = {
  ticker: 'T1',
  status: 'active',
  yes_ask_dollars: '0.4600',
  no_ask_dollars: '0.5200',
  yes_ask_size_fp: '1307.00',
  yes_bid_size_fp: '70.00',
};
const EVENT = { event_ticker: 'E1', mutually_exclusive: true, markets: [MARKET] };

test('topsFromEvent keys both sides of every market', () => {
  const tops = topsFromEvent(EVENT, asksFromMarket);
  closeTo(tops.get('T1:YES').ask, 0.46, 'yes ask');
  closeTo(tops.get('T1:YES').askSize, 1307, 'yes ask size is the NO-bid queue');
  closeTo(tops.get('T1:NO').ask, 0.52, 'no ask');
  closeTo(tops.get('T1:NO').askSize, 70, 'no ask size is the YES-bid queue');
});

test('topsFromEvent tolerates a malformed event or market', () => {
  for (const bad of [null, undefined, 'x', {}, { markets: 'nope' }]) {
    assert.equal(topsFromEvent(bad, asksFromMarket).size, 0, String(bad));
  }
  assert.equal(topsFromEvent({ markets: [{ ticker: '' }, null, { nope: 1 }] }, asksFromMarket).size, 0);
});

test('createPollStore presents the same top() surface the WebSocket store does', () => {
  // So scanSets consumes either without knowing which venue produced it.
  const rows = [{ tokenId: 'T1:YES', fetchedAtMs: 5000 }, { tokenId: 'T1:NO', fetchedAtMs: 5000 }];
  const store = createPollStore(rows, topsFromEvent(EVENT, asksFromMarket));
  const yes = store.top('T1:YES');
  closeTo(yes.bestAsk, 0.46, 'bestAsk');
  closeTo(yes.askSize, 1307, 'askSize');
  assert.equal(yes.ts, 5000, 'the page fetch time, not the scan time');
  assert.equal(yes.bestBid, null, 'a buyer never reads the bid side');
  assert.equal(store.size, 2);
  assert.deepEqual(store.tokens().sort(), ['T1:NO', 'T1:YES']);
});

test('createPollStore reports an unquoted token as absent rather than inventing a price', () => {
  const store = createPollStore([{ tokenId: 'ghost', fetchedAtMs: 1 }], new Map());
  assert.equal(store.top('ghost'), null);
  assert.equal(store.top('never-seen'), null);
  assert.equal(store.size, 0);
});

test('createPollStore carries a null fetch stamp through rather than defaulting it', () => {
  // A missing stamp must not become "now", which would make a stale crawl look fresh and
  // sail through the freshness gate.
  const store = createPollStore([{ tokenId: 'T1:YES' }], topsFromEvent(EVENT, asksFromMarket));
  assert.equal(store.top('T1:YES').ts, null);
});
