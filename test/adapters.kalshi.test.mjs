import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KIND_BINARY, KIND_NEG_RISK } from '../lib/arb.mjs';
import {
  EVENTS_URL,
  NAME,
  asksFromMarket,
  asksFromOrderbook,
  bestBid,
  discoverMarkets,
  feeFnFor,
  groupIntoSets,
  normalizeEvent,
  normalizeMarket,
} from '../lib/adapters/kalshi.mjs';

const EPS = 1e-12;
const closeTo = (a, e, m) =>
  assert.ok(Math.abs(a - e) < EPS, `${m ?? 'value'}: expected ${e} +/- ${EPS}, got ${a}`);

/**
 * A REAL orderbook, captured live 2026-07-31 from
 * GET /trade-api/v2/markets/KXNEWPOPE-70-PPIZ/orderbook?depth=5
 *
 * Bids-only on BOTH sides, both ladders ASCENDING (best last). Prices and sizes are
 * strings. Kept verbatim so the fixture cannot drift into a shape the venue never sends.
 */
const REAL_ORDERBOOK = {
  no_dollars: [
    ['0.9000', '416.00'],
    ['0.9260', '32.44'],
    ['0.9290', '150.00'],
    ['0.9500', '55.00'],
    ['0.9540', '1307.00'],
  ],
  yes_dollars: [
    ['0.0100', '311.00'],
    ['0.0200', '1000.00'],
    ['0.0300', '2000.00'],
    ['0.0350', '1000.00'],
    ['0.0400', '70.00'],
  ],
};

/** The same market's nested object from the SAME live session — the cross-check. */
const REAL_MARKET = {
  ticker: 'KXNEWPOPE-70-PPIZ',
  status: 'active',
  yes_bid_dollars: '0.0400',
  yes_ask_dollars: '0.0460',
  no_bid_dollars: '0.9540',
  no_ask_dollars: '0.9600',
  yes_bid_size_fp: '70.00',
  yes_ask_size_fp: '1307.00',
  price_level_structure: 'tapered_deci_cent',
  last_updated_ts: 1785500000000,
};

/** A real mutually-exclusive event shape (2 of the 7 real members). */
const REAL_EVENT = {
  event_ticker: 'KXNEWPOPE-70',
  series_ticker: 'KXNEWPOPE',
  title: 'Who will the next Pope be?',
  category: 'Elections',
  mutually_exclusive: true,
  markets: [
    REAL_MARKET,
    {
      ticker: 'KXNEWPOPE-70-PPAR',
      status: 'active',
      yes_bid_dollars: '0.0420',
      yes_ask_dollars: '0.0500',
      no_bid_dollars: '0.9500',
      no_ask_dollars: '0.9580',
      yes_bid_size_fp: '200.00',
      yes_ask_size_fp: '900.00',
      price_level_structure: 'tapered_deci_cent',
      last_updated_ts: 1785500000000,
    },
  ],
};

/** A real NON-mutually-exclusive event: a plain binary question, one market. */
const REAL_BINARY_EVENT = {
  event_ticker: 'KXELONMARS-99',
  category: 'World',
  mutually_exclusive: false,
  markets: [
    {
      ticker: 'KXELONMARS-99-X',
      status: 'active',
      yes_bid_dollars: '0.4000',
      yes_ask_dollars: '0.4500',
      no_bid_dollars: '0.5500',
      no_ask_dollars: '0.6000',
      yes_bid_size_fp: '300.00',
      yes_ask_size_fp: '500.00',
      price_level_structure: 'linear_cent',
      last_updated_ts: 1785500000000,
    },
  ],
};

// ── identity ────────────────────────────────────────────────────────────────

test('NAME and EVENTS_URL match the venue', () => {
  assert.equal(NAME, 'kalshi');
  assert.equal(EVENTS_URL, 'https://api.elections.kalshi.com/trade-api/v2/events');
});

// ── bestBid ─────────────────────────────────────────────────────────────────

test('bestBid takes the MAXIMUM, not the last element', () => {
  // The live ladders ascend, so last happens to be best — but nothing documents that,
  // and a reordering would silently misprice every leg.
  closeTo(bestBid(REAL_ORDERBOOK.yes_dollars).price, 0.04, 'best yes bid');
  closeTo(bestBid(REAL_ORDERBOOK.yes_dollars).size, 70, 'its size');
  closeTo(bestBid(REAL_ORDERBOOK.no_dollars).price, 0.954, 'best no bid');
  closeTo(bestBid(REAL_ORDERBOOK.no_dollars).size, 1307, 'its size');

  const shuffled = [...REAL_ORDERBOOK.no_dollars].reverse();
  closeTo(bestBid(shuffled).price, 0.954, 'ordering-independent');
  closeTo(bestBid(shuffled).size, 1307, 'and its size');
});

test('bestBid skips unusable levels and reports an empty queue as null', () => {
  assert.equal(bestBid([]), null);
  assert.equal(bestBid(undefined), null);
  assert.equal(bestBid('nope'), null);
  assert.equal(bestBid([['abc', '1'], ['0.5', 'xyz'], ['0.3', '0']]), null, 'none usable');
  closeTo(bestBid([['abc', '1'], ['0.30', '5']]).price, 0.3, 'the good level survives');
  // a zero-size level is not tradeable liquidity
  closeTo(bestBid([['0.90', '0'], ['0.30', '5']]).price, 0.3, 'zero size ignored');
});

// ── asksFromOrderbook — the whole Kalshi transform ──────────────────────────

test('asksFromOrderbook mirrors each bid queue into the OPPOSITE ask', () => {
  // The venue quotes no asks at all. A NO bid at 0.954 IS someone offering YES at 0.046,
  // for that NO bid's size. Cross-checked below against the venue's own derived fields.
  const a = asksFromOrderbook(REAL_ORDERBOOK);
  closeTo(a.yesAsk, 0.046, 'yesAsk = 1 - 0.954');
  closeTo(a.yesAskSize, 1307, 'yesAskSize is the NO-bid size');
  closeTo(a.noAsk, 0.96, 'noAsk = 1 - 0.04');
  closeTo(a.noAskSize, 70, 'noAskSize is the YES-bid size');
});

test('the derived asks agree with the venue-reported ones, EXACTLY', () => {
  // Same market, same live session, two independent paths. This is what pins the
  // transform: if the mirror were wrong the two would disagree.
  const derived = asksFromOrderbook(REAL_ORDERBOOK);
  const reported = asksFromMarket(REAL_MARKET);
  closeTo(derived.yesAsk, reported.yesAsk, 'yesAsk');
  closeTo(derived.yesAskSize, reported.yesAskSize, 'yesAskSize');
  closeTo(derived.noAsk, reported.noAsk, 'noAsk');
  closeTo(derived.noAskSize, reported.noAskSize, 'noAskSize');
});

test('the ask SIZES come from the opposite queue, which is the easy thing to get backwards', () => {
  // Swapping them leaves both PRICES right and both SIZES wrong — the leg would be sized
  // against liquidity that is not there. 1307 and 70 are far apart on purpose.
  const a = asksFromMarket(REAL_MARKET);
  assert.notEqual(a.yesAskSize, a.noAskSize);
  closeTo(a.yesAskSize, 1307, 'YES buyer lifts the NO-bid queue');
  closeTo(a.noAskSize, 70, 'NO buyer lifts the YES-bid queue');
});

test('a complete set on this real market costs MORE than $1, so it is no arbitrage', () => {
  // 0.046 + 0.96 = 1.006 gross, before any fee. A sanity anchor on the whole transform:
  // if the mirror were inverted this would come out at 0.994 and look like free money.
  const a = asksFromOrderbook(REAL_ORDERBOOK);
  closeTo(a.yesAsk + a.noAsk, 1.006, 'gross cost of the pair');
  assert.ok(a.yesAsk + a.noAsk > 1);
});

test('asksFromOrderbook reports a one-sided book as null on the missing side', () => {
  const noNoBids = asksFromOrderbook({ ...REAL_ORDERBOOK, no_dollars: [] });
  assert.equal(noNoBids.yesAsk, null, 'no NO bids means nobody is offering YES');
  assert.equal(noNoBids.yesAskSize, null);
  closeTo(noNoBids.noAsk, 0.96, 'the other side still reads');

  const empty = asksFromOrderbook({});
  assert.equal(empty.yesAsk, null);
  assert.equal(empty.noAsk, null);
});

test('an EMPTY bid queue is no offer, not an ask at 1.00', () => {
  // Found live on the first real crawl: a market nobody is bidding on reports
  // yes_bid 0.0000, and 1 - 0 = 1.00 reached the pricing core as a degenerate leg and
  // threw mid-crawl, taking down a scan that should have skipped the market.
  const noYesBids = asksFromOrderbook({ ...REAL_ORDERBOOK, yes_dollars: [] });
  assert.equal(noYesBids.noAsk, null, 'not 1.00');
  assert.equal(noYesBids.noAskSize, null);

  const reported = asksFromMarket({
    ...REAL_MARKET,
    yes_bid_dollars: '0.0000',
    no_ask_dollars: '1.0000',
    yes_bid_size_fp: '0.00',
  });
  assert.equal(reported.noAsk, null, 'an ask at exactly 1.00 is the absence of an offer');
  assert.equal(reported.noAskSize, null);
  closeTo(reported.yesAsk, 0.046, 'the other side is untouched');
});

test('an ask at or below 0 is likewise not liftable', () => {
  const a = asksFromMarket({ ...REAL_MARKET, yes_ask_dollars: '0.0000' });
  assert.equal(a.yesAsk, null);
  assert.equal(a.yesAskSize, null);
});

test('asksFromOrderbook and asksFromMarket reject a non-object', () => {
  for (const bad of [null, undefined, 'x', 7]) {
    assert.throws(() => asksFromOrderbook(bad), /orderbook must be an object/, String(bad));
    assert.throws(() => asksFromMarket(bad), /market must be an object/, String(bad));
  }
});

test('asksFromMarket nulls a size whose price is missing', () => {
  const a = asksFromMarket({ ...REAL_MARKET, yes_ask_dollars: null });
  assert.equal(a.yesAsk, null);
  assert.equal(a.yesAskSize, null, 'a size without a price cannot be acted on');
});

// ── normalizeMarket / normalizeEvent ────────────────────────────────────────

test('normalizeMarket emits one row per side with a unique token id', () => {
  const rows = normalizeMarket(REAL_MARKET, {
    eventTicker: 'KXNEWPOPE-70',
    mutuallyExclusive: true,
    groupSize: 7,
    category: 'Elections',
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.outcome), ['Yes', 'No']);
  // Kalshi has no token ids, so one is synthesised per tradeable side.
  assert.equal(rows[0].tokenId, 'KXNEWPOPE-70-PPIZ:YES');
  assert.equal(rows[1].tokenId, 'KXNEWPOPE-70-PPIZ:NO');
  assert.equal(rows[0].venue, 'kalshi');
  assert.equal(rows[0].conditionId, 'KXNEWPOPE-70-PPIZ');
  assert.equal(rows[0].eventKey, 'KXNEWPOPE-70', 'a group member keys to the GROUP');
  assert.equal(rows[0].negRisk, true);
  assert.equal(rows[0].negRiskGroupSize, 7);
  closeTo(rows[0].feeRate, 0.07, 'the single Kalshi rate');
});

test('normalizeMarket keys a standalone market to its own ticker', () => {
  const rows = normalizeMarket(REAL_BINARY_EVENT.markets[0], {
    eventTicker: 'KXELONMARS-99',
    mutuallyExclusive: false,
  });
  assert.equal(rows[0].eventKey, 'KXELONMARS-99-X');
  assert.equal(rows[0].negRisk, false);
  assert.equal(rows[0].negRiskGroupSize, null);
});

test('normalizeMarket maps the two tick regimes', () => {
  const tapered = normalizeMarket(REAL_MARKET, { eventTicker: 'e' });
  assert.equal(tapered[0].tickSize, 0.001, 'tapered_deci_cent');
  const linear = normalizeMarket(REAL_BINARY_EVENT.markets[0], { eventTicker: 'e' });
  assert.equal(linear[0].tickSize, 0.01, 'linear_cent');
});

test('normalizeMarket drops anything not active, or with no ticker', () => {
  for (const patch of [{ status: 'closed' }, { status: 'settled' }, { status: undefined }, { ticker: '' }, { ticker: 7 }]) {
    assert.deepEqual(normalizeMarket({ ...REAL_MARKET, ...patch }, { eventTicker: 'e' }), [], JSON.stringify(patch));
  }
  for (const bad of [null, undefined, 'x', 7]) {
    assert.deepEqual(normalizeMarket(bad, { eventTicker: 'e' }), [], String(bad));
  }
});

test('normalizeMarket drops a group member with no usable event key', () => {
  assert.deepEqual(normalizeMarket(REAL_MARKET, { mutuallyExclusive: true }), []);
  assert.deepEqual(normalizeMarket(REAL_MARKET, { mutuallyExclusive: true, eventTicker: '' }), []);
});

test('normalizeEvent stamps the declared group size from the event itself', () => {
  const rows = normalizeEvent(REAL_EVENT);
  assert.equal(rows.length, 4, 'two markets x two sides');
  assert.equal(rows[0].negRiskGroupSize, 2);
  assert.equal(rows[0].venueCategory, 'Elections', 'editorial category kept for reporting');
});

test('normalizeEvent counts group size BEFORE filtering untradeable members', () => {
  // A group with a closed outcome is genuinely incomplete — you cannot buy every
  // outcome — so it must not shrink to fit whichever members happen to be open.
  const withClosed = {
    ...REAL_EVENT,
    markets: [REAL_EVENT.markets[0], { ...REAL_EVENT.markets[1], status: 'closed' }],
  };
  const rows = normalizeEvent(withClosed);
  assert.equal(rows.length, 2, 'only the active market normalizes');
  assert.equal(rows[0].negRiskGroupSize, 2, 'but the declared size still says 2');
  assert.equal(groupIntoSets(rows).filter((s) => s.kind === KIND_NEG_RISK).length, 0);
});

test('normalizeEvent tolerates a malformed or market-less event', () => {
  for (const bad of [null, undefined, 'x', {}, { markets: 'nope' }]) {
    assert.deepEqual(normalizeEvent(bad), [], String(bad));
  }
});

// ── grouping, via the SHARED implementation ─────────────────────────────────

test('a mutually-exclusive event yields both binary sets and the group set', () => {
  const sets = groupIntoSets(normalizeEvent(REAL_EVENT));
  assert.equal(sets.filter((s) => s.kind === KIND_BINARY).length, 2, 'one per member market');
  const neg = sets.filter((s) => s.kind === KIND_NEG_RISK);
  assert.equal(neg.length, 1);
  assert.equal(neg[0].eventKey, 'KXNEWPOPE-70');
  assert.deepEqual(neg[0].legs.map((l) => l.outcome), ['Yes', 'Yes'], 'YES legs only');
});

test('a standalone event yields exactly one binary set and no group', () => {
  const sets = groupIntoSets(normalizeEvent(REAL_BINARY_EVENT));
  assert.equal(sets.length, 1);
  assert.equal(sets[0].kind, KIND_BINARY);
  assert.equal(sets[0].eventKey, 'KXELONMARS-99-X');
});

test('a group short of its declared size is dropped', () => {
  const short = normalizeEvent({ ...REAL_EVENT, markets: [REAL_EVENT.markets[0]] });
  // one market normalizes, but the event declared 1 so the group is complete-of-one...
  // which the shared rule still rejects, since a one-outcome "set" is not a set.
  const { sets, dropped } = groupIntoSets(short, { withDrops: true });
  assert.equal(sets.filter((s) => s.kind === KIND_NEG_RISK).length, 0);
  assert.ok(dropped.some((d) => d.reason === 'incomplete_neg_risk'));
});

// ── fees ────────────────────────────────────────────────────────────────────

test('feeFnFor prices at the single Kalshi rate, side-independently', () => {
  const fee = feeFnFor();
  // 0.07 * 0.5 * 0.5 = 0.0175
  closeTo(fee(0.5), 0.0175, 'at 0.50');
  // 0.07 * 0.62 * 0.38 = 0.016492, and the same at 0.38
  closeTo(fee(0.62), 0.016492, 'at 0.62');
  closeTo(fee(0.38), 0.016492, 'mirror price costs the same');
});

test('feeFnFor needs no category, unlike Polymarket, so nothing can fail to map', () => {
  assert.doesNotThrow(() => feeFnFor());
  assert.doesNotThrow(() => feeFnFor({ category: undefined }));
});

// ── discoverMarkets ─────────────────────────────────────────────────────────

test('discoverMarkets pages by cursor and normalizes nested events', async () => {
  const pages = [
    { events: [REAL_EVENT], cursor: 'c1' },
    { events: [REAL_BINARY_EVENT], cursor: '' },
  ];
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => pages.shift() ?? { events: [] } };
  };
  const rows = await discoverMarkets({ fetchImpl, pageSize: 1, maxPages: 5 });
  assert.equal(rows.length, 6, '(2 + 1) markets x 2 sides');
  assert.ok(urls[0].includes('with_nested_markets=true'), urls[0]);
  assert.ok(urls[0].includes('status=open'), urls[0]);
  assert.ok(!urls[0].includes('cursor='), 'no cursor on the first page');
  assert.ok(urls[1].includes('cursor=c1'), urls[1]);
  assert.equal(urls.length, 2, 'stops on the empty cursor');
});

test('a repeated cursor cannot duplicate rows', async () => {
  // Stopping after consuming the echo would be worse than looping: duplicated rows give
  // a binary group four legs instead of two, and groupIntoSets drops it as incomplete —
  // so a cursor loop would silently zero the crawl out rather than inflate it.
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ events: [REAL_EVENT], cursor: 'same' }) };
  };
  const rows = await discoverMarkets({ fetchImpl, pageSize: 1, maxPages: 20, sleep: async () => {} });
  // An echo is only detectable once seen twice, so the repeat page does arrive — which
  // is exactly why rows are deduped by token id rather than trusting the cursor.
  assert.equal(calls, 2, 'and then never again');
  assert.equal(rows.length, 4, 'one event, two markets, two sides -- NO duplicates');
  // and the rows still group into complete sets, which duplicates would have prevented
  const sets = groupIntoSets(rows);
  assert.equal(sets.filter((s) => s.kind === KIND_BINARY).length, 2);
});

test('discoverMarkets does not re-fetch a cursor seen on an EARLIER page', async () => {
  const cursors = ['c1', 'c2', 'c1'];
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ events: [REAL_EVENT], cursor: cursors.shift() ?? '' }) };
  };
  await discoverMarkets({ fetchImpl, maxPages: 20, sleep: async () => {} });
  assert.equal(calls, 3, 'stops when c1 comes round again');
});

test('discoverMarkets stops at maxPages', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ events: [REAL_EVENT], cursor: `c${calls}` }) };
  };
  await discoverMarkets({ fetchImpl, maxPages: 3 });
  assert.equal(calls, 3);
});

test('discoverMarkets throws rather than returning a short list', async () => {
  await assert.rejects(
    () => discoverMarkets({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) }),
    /Kalshi discovery failed: HTTP 503/,
  );
  for (const body of [[], null, { nope: 1 }, 'x']) {
    await assert.rejects(
      () => discoverMarkets({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => body }) }),
      /expected an object with an events array/,
      JSON.stringify(body),
    );
  }
});

test('discoverMarkets requires an injectable fetch so tests never hit the network', async () => {
  await assert.rejects(
    () => discoverMarkets({ fetchImpl: 'nope' }),
    /fetchImpl must be a function/,
  );
});

test('discoverMarkets RETRIES a 429 with backoff rather than abandoning the crawl', async () => {
  // Measured live: paging without a delay returns 429 on the second page, so an
  // unthrottled crawl fails outright. A transient limit must not lose a whole crawl.
  const statuses = [429, 429, 200];
  const waits = [];
  const fetchImpl = async () => {
    const status = statuses.shift() ?? 200;
    return { ok: status === 200, status, json: async () => ({ events: [REAL_EVENT], cursor: '' }) };
  };
  const rows = await discoverMarkets({
    fetchImpl,
    pageDelayMs: 10,
    sleep: async (ms) => waits.push(ms),
  });
  assert.equal(rows.length, 4, 'the crawl completed after the retries');
  // backoff doubles: 10*2^1, 10*2^2
  assert.deepEqual(waits, [20, 40]);
});

test('discoverMarkets gives up on a PERSISTENT 429 rather than returning a short list', async () => {
  // A short list turns a complete set into an incomplete one, which prices too cheaply.
  await assert.rejects(
    () =>
      discoverMarkets({
        fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }),
        pageDelayMs: 1,
        maxRetries: 2,
        sleep: async () => {},
      }),
    /Kalshi discovery failed: HTTP 429/,
  );
});

test('discoverMarkets spaces pages apart and stamps each row with ITS page time', async () => {
  // A row from page 1 really is stale by the time page 40 lands, and the venue publishes
  // no book timestamp, so per-page stamping is the only honest age available.
  let clock = 1000;
  const waits = [];
  const pages = [
    { events: [REAL_EVENT], cursor: 'c1' },
    { events: [REAL_BINARY_EVENT], cursor: '' },
  ];
  const rows = await discoverMarkets({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => pages.shift() ?? { events: [] } }),
    pageDelayMs: 300,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  assert.deepEqual(waits, [300], 'one inter-page delay for two pages');
  const page1 = rows.filter((r) => r.conditionId.startsWith('KXNEWPOPE'));
  const page2 = rows.filter((r) => r.conditionId.startsWith('KXELONMARS'));
  assert.equal(page1[0].fetchedAtMs, 1000);
  assert.equal(page2[0].fetchedAtMs, 1300, 'the later page carries a later stamp');
});
