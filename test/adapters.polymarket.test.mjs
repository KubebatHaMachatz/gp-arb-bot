import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KIND_BINARY, KIND_NEG_RISK } from '../lib/arb.mjs';
import {
  FEE_TYPE_TO_CATEGORY,
  NAME,
  bookTopFromBook,
  discoverMarkets,
  feeCategoryFor,
  feeFnFor,
  groupIntoSets,
  normalizeMarket,
} from '../lib/adapters/polymarket.mjs';

const EPS = 1e-12;
const closeTo = (a, e, m) =>
  assert.ok(Math.abs(a - e) < EPS, `${m ?? 'value'}: expected ${e} +/- ${EPS}, got ${a}`);

/**
 * REAL responses, captured live 2026-07-31 and trimmed to the fields the adapter reads.
 * Sources: GET https://gamma-api.polymarket.com/markets?closed=false
 *          GET https://clob.polymarket.com/book?token_id=...
 * Kept verbatim (including the JSON-string-inside-JSON encoding of `clobTokenIds` and
 * `outcomes`, and the string prices/sizes in the book) so the fixtures cannot drift into
 * a shape the venue does not actually send.
 */
const REAL_BINARY = {
  conditionId: '0x1fad72fae204143ff1c3035e99e7c0f65ea8d5cd9bd1070987bd1a3316f772be',
  clobTokenIds:
    '["98022490269692409998126496127597032490334070080325855126491859374983463996227", "53831553061883006530739877284105938919721408776239639687877978808906551086026"]',
  outcomes: '["Yes", "No"]',
  groupItemTitle: 'New Rihanna Album',
  negRisk: false,
  negRiskMarketID: null,
  negRiskOther: false,
  feeType: 'general_fees',
  feesEnabled: true,
  orderMinSize: 5,
  orderPriceMinTickSize: 0.01,
  slug: 'new-rhianna-album-before-gta-vi-926',
  acceptingOrders: true,
  closed: false,
  active: true,
};

const NEG_RISK_ID = '0x2c3d7e0eee6f058be3006baabf0d54a07da254ba47fe6e3e095e7990c7814700';

/** Two members of a real 51-market neg-risk group (2028 Democratic nomination). */
const REAL_NEG_RISK = [
  {
    conditionId: '0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75',
    clobTokenIds:
      '["54533043819946592547517511176940999955633860128497669742211153063842200957669", "87854174148074652060467921081181402357467303721471806610111179101805869578687"]',
    outcomes: '["Yes", "No"]',
    groupItemTitle: 'Gavin Newsom',
    negRisk: true,
    negRiskMarketID: NEG_RISK_ID,
    negRiskOther: false,
    feeType: 'politics_fees',
    feesEnabled: true,
    orderMinSize: 5,
    orderPriceMinTickSize: 0.001,
    slug: 'will-gavin-newsom-win-the-2028-democratic-presidential-nomination-568',
    acceptingOrders: true,
    closed: false,
    active: true,
  },
  {
    conditionId: '0xe6bcc2f1dd025ce5e1833190f7c60a71171c94f805df55b9ab0ded695ec93565',
    clobTokenIds:
      '["107064985435494333113391038470401719113272800530429703182710416066774068907304", "65176072261324737856085688071627118509549293922582857186996392180609764586527"]',
    outcomes: '["Yes", "No"]',
    groupItemTitle: 'Alexandria Ocasio-Cortez',
    negRisk: true,
    negRiskMarketID: NEG_RISK_ID,
    negRiskOther: false,
    feeType: 'politics_fees',
    feesEnabled: true,
    orderMinSize: 5,
    orderPriceMinTickSize: 0.001,
    slug: 'will-alexandria-ocasio-cortez-win-the-2028-democratic-presidential-nomination-653',
    acceptingOrders: true,
    closed: false,
    active: true,
  },
];

/**
 * A REAL `GET /book` response, trimmed to the first and last few levels per side.
 * The ordering is preserved exactly: bids ASCEND and asks DESCEND, so on BOTH sides the
 * best price is the LAST element. Gamma independently reported bestBid 0.193 /
 * bestAsk 0.194 for this token at capture time, which is what pins the convention.
 */
const REAL_BOOK = {
  market: '0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75',
  asset_id: '54533043819946592547517511176940999955633860128497669742211153063842200957669',
  timestamp: '1785495025805',
  min_order_size: '5',
  tick_size: '0.001',
  neg_risk: true,
  bids: [
    { price: '0.001', size: '2756598' },
    { price: '0.192', size: '5547.95' },
    { price: '0.193', size: '419.95' },
  ],
  asks: [
    { price: '0.999', size: '6149778.01' },
    { price: '0.195', size: '6862.72' },
    { price: '0.194', size: '34612.41' },
  ],
};

// ── identity and the fee-type table ─────────────────────────────────────────

test('NAME matches the venue column value used everywhere else', () => {
  assert.equal(NAME, 'polymarket');
});

test('FEE_TYPE_TO_CATEGORY covers every feeType observed live, and is frozen', () => {
  // Enumerated over 500 unique live markets on 2026-07-31.
  assert.equal(FEE_TYPE_TO_CATEGORY.politics_fees, 'politics');
  assert.equal(FEE_TYPE_TO_CATEGORY.sports_fees_v2, 'sports');
  assert.equal(FEE_TYPE_TO_CATEGORY.crypto_fees_v2, 'crypto');
  assert.equal(FEE_TYPE_TO_CATEGORY.tech_fees, 'tech');
  assert.equal(FEE_TYPE_TO_CATEGORY.culture_fees, 'culture');
  assert.equal(FEE_TYPE_TO_CATEGORY.weather_fees, 'weather');
  assert.equal(FEE_TYPE_TO_CATEGORY.economics_fees, 'economics');
  assert.equal(FEE_TYPE_TO_CATEGORY.finance_prices_fees, 'finance');
  assert.equal(Object.isFrozen(FEE_TYPE_TO_CATEGORY), true);
});

// ── feeCategoryFor ──────────────────────────────────────────────────────────

test('feeCategoryFor maps a known feeType to its lib/fees.mjs category', () => {
  assert.equal(feeCategoryFor({ feeType: 'politics_fees', feesEnabled: true }), 'politics');
  assert.equal(feeCategoryFor({ feeType: 'crypto_fees_v2', feesEnabled: true }), 'crypto');
});

test('feeCategoryFor treats a null feeType as genuinely fee-free', () => {
  // Verified on 500 live markets: feesEnabled is true for exactly the non-null feeTypes
  // (465 vs 35, zero exceptions). A null feeType is the fee-exempt bucket, which
  // lib/fees.mjs already models as the zero-rate 'geopolitics' category.
  assert.equal(feeCategoryFor({ feeType: null, feesEnabled: false }), 'geopolitics');
  assert.equal(feeCategoryFor({ feesEnabled: false }), 'geopolitics');
});

test('feeCategoryFor returns null for an UNMAPPED feeType rather than guessing', () => {
  // `general_fees` is real (15 of 500 live markets) but its stem is not a category in
  // lib/fees.mjs, so its rate is genuinely unknown. Guessing 0.05 could understate a
  // 0.07 market and manufacture edge; the market is dropped instead, and counted.
  assert.equal(feeCategoryFor({ feeType: 'general_fees', feesEnabled: true }), null);
  assert.equal(feeCategoryFor({ feeType: 'brand_new_fees', feesEnabled: true }), null);
});

test('feeCategoryFor does NOT treat a missing feeType as free when fees are ENABLED', () => {
  // The dangerous shape: fees are on, but we cannot tell at what rate. Must not fall
  // through to the zero-rate branch.
  assert.equal(feeCategoryFor({ feeType: null, feesEnabled: true }), null);
});

test('feeCategoryFor does not resolve feeTypes through the prototype chain', () => {
  for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(feeCategoryFor({ feeType: bad, feesEnabled: true }), null, bad);
  }
});

// ── normalizeMarket ─────────────────────────────────────────────────────────

test('normalizeMarket emits one row per outcome token, shaped for the markets table', () => {
  const rows = normalizeMarket(REAL_NEG_RISK[0]);
  assert.equal(rows.length, 2);
  const [yes, no] = rows;
  assert.equal(yes.venue, 'polymarket');
  assert.equal(yes.outcome, 'Yes');
  assert.equal(
    yes.tokenId,
    '54533043819946592547517511176940999955633860128497669742211153063842200957669',
  );
  assert.equal(no.outcome, 'No');
  assert.equal(
    no.tokenId,
    '87854174148074652060467921081181402357467303721471806610111179101805869578687',
  );
  assert.equal(yes.conditionId, '0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75');
  assert.equal(yes.category, 'politics');
  closeTo(yes.feeRate, 0.04, 'politics feeRate');
  assert.equal(yes.tickSize, 0.001);
  assert.equal(yes.minOrderSize, 5);
  assert.equal(yes.negRisk, true);
});

test('normalizeMarket keys a neg-risk row to the GROUP and a binary row to its own condition', () => {
  // The grouping fact this whole adapter turns on: a neg-risk set is every market
  // sharing a negRiskMarketID, not one market with N outcomes.
  assert.equal(normalizeMarket(REAL_NEG_RISK[0])[0].eventKey, NEG_RISK_ID);
  assert.equal(
    normalizeMarket(REAL_BINARY)[0].eventKey,
    '0x1fad72fae204143ff1c3035e99e7c0f65ea8d5cd9bd1070987bd1a3316f772be',
  );
});

test('normalizeMarket carries a null category through for an unmapped feeType', () => {
  // REAL_BINARY is a live `general_fees` market — unmapped on purpose.
  const rows = normalizeMarket(REAL_BINARY);
  assert.equal(rows[0].category, null);
  assert.equal(rows[0].feeRate, null);
});

test('normalizeMarket drops a market that cannot be traded right now', () => {
  for (const patch of [{ closed: true }, { active: false }, { acceptingOrders: false }]) {
    assert.deepEqual(normalizeMarket({ ...REAL_BINARY, ...patch }), [], JSON.stringify(patch));
  }
});

test('normalizeMarket drops a market whose token/outcome encoding is unusable', () => {
  for (const patch of [
    { clobTokenIds: 'not json' },
    { outcomes: 'not json' },
    { clobTokenIds: '["only-one-token"]' }, // length mismatch vs 2 outcomes
    { clobTokenIds: '"a string not an array"' },
    { clobTokenIds: '[]', outcomes: '[]' }, // a market with no tokens at all
    { clobTokenIds: undefined },
    { outcomes: undefined },
  ]) {
    assert.deepEqual(normalizeMarket({ ...REAL_BINARY, ...patch }), [], JSON.stringify(patch));
  }
});

test('normalizeMarket drops a market with an unusable tick or minimum size', () => {
  for (const patch of [
    { orderPriceMinTickSize: 0 },
    { orderPriceMinTickSize: null },
    { orderMinSize: 0 },
    { orderMinSize: -5 },
  ]) {
    assert.deepEqual(normalizeMarket({ ...REAL_BINARY, ...patch }), [], JSON.stringify(patch));
  }
});

test('normalizeMarket rejects a non-object input rather than throwing on property access', () => {
  for (const bad of [null, undefined, 'x', 42]) {
    assert.deepEqual(normalizeMarket(bad), [], String(bad));
  }
});

test('normalizeMarket falls back to conditionId when a neg-risk market has no group id', () => {
  // Defensive: negRisk true with a missing negRiskMarketID would otherwise key the row
  // to undefined and silently pool unrelated markets into one "group".
  const rows = normalizeMarket({ ...REAL_NEG_RISK[0], negRiskMarketID: null });
  assert.equal(rows[0].eventKey, REAL_NEG_RISK[0].conditionId);
});

test('normalizeMarket drops a market with no usable event key at all', () => {
  assert.deepEqual(
    normalizeMarket({ ...REAL_BINARY, conditionId: null, negRiskMarketID: null }),
    [],
  );
  assert.deepEqual(normalizeMarket({ ...REAL_BINARY, conditionId: '' }), []);
});

test('normalizeMarket carries the negRiskOther flag and tolerates a missing slug', () => {
  // The "Other" leg is part of the complete set, so it must survive normalization
  // rather than being filtered as an oddity.
  const other = normalizeMarket({ ...REAL_NEG_RISK[0], negRiskOther: true, slug: undefined });
  assert.equal(other[0].negRiskOther, true);
  assert.equal(other[0].marketSlug, null);
  assert.equal(normalizeMarket(REAL_NEG_RISK[0])[0].negRiskOther, false);
});

// ── groupIntoSets ───────────────────────────────────────────────────────────

test('groupIntoSets builds a binary set from a Yes/No pair', () => {
  const sets = groupIntoSets(normalizeMarket(REAL_NEG_RISK[0]));
  const binary = sets.filter((s) => s.kind === KIND_BINARY);
  assert.equal(binary.length, 1);
  assert.equal(binary[0].legs.length, 2);
  assert.deepEqual(binary[0].legs.map((l) => l.outcome), ['Yes', 'No']);
  assert.equal(binary[0].eventKey, REAL_NEG_RISK[0].conditionId);
});

test('groupIntoSets builds a neg-risk set from the YES leg of every group member', () => {
  const rows = REAL_NEG_RISK.flatMap(normalizeMarket);
  const sets = groupIntoSets(rows);
  const neg = sets.filter((s) => s.kind === KIND_NEG_RISK);
  assert.equal(neg.length, 1);
  assert.equal(neg[0].eventKey, NEG_RISK_ID);
  // exactly the YES tokens, one per member market — never the NO legs
  assert.equal(neg[0].legs.length, 2);
  assert.deepEqual(neg[0].legs.map((l) => l.outcome), ['Yes', 'Yes']);
  assert.deepEqual(
    neg[0].legs.map((l) => l.conditionId).sort(),
    REAL_NEG_RISK.map((m) => m.conditionId).sort(),
  );
});

test('one neg-risk market yields BOTH its own binary set and membership of the group set', () => {
  // Both are genuine complete sets with different unwind mechanics (CTF merge vs
  // NegRiskAdapter convert), so neither may shadow the other.
  const rows = REAL_NEG_RISK.flatMap(normalizeMarket);
  const sets = groupIntoSets(rows);
  assert.equal(sets.filter((s) => s.kind === KIND_BINARY).length, 2);
  assert.equal(sets.filter((s) => s.kind === KIND_NEG_RISK).length, 1);
});

test('groupIntoSets DROPS an incomplete binary group', () => {
  // A set missing an outcome is not a complete set: pricing it would compare the cost of
  // some outcomes against a $1 payout that requires all of them, understating cost and
  // inventing an edge that cannot be redeemed.
  const [yesOnly] = normalizeMarket(REAL_NEG_RISK[0]);
  const sets = groupIntoSets([yesOnly]);
  assert.equal(sets.filter((s) => s.kind === KIND_BINARY).length, 0);
});

test('groupIntoSets DROPS a duplicated-outcome group rather than pricing it', () => {
  const [yes] = normalizeMarket(REAL_NEG_RISK[0]);
  const sets = groupIntoSets([yes, { ...yes, tokenId: 'other-token' }]);
  assert.equal(sets.filter((s) => s.kind === KIND_BINARY).length, 0);
});

test('groupIntoSets DROPS a neg-risk group with only one member', () => {
  const rows = normalizeMarket(REAL_NEG_RISK[0]);
  const sets = groupIntoSets(rows);
  assert.equal(sets.filter((s) => s.kind === KIND_NEG_RISK).length, 0);
});

test('groupIntoSets DROPS any set containing a leg with no known fee rate', () => {
  // An unmapped fee type means the cost of that leg is unknown; a set priced without it
  // would be priced too cheaply. Dropping is the only honest option.
  const sets = groupIntoSets(normalizeMarket(REAL_BINARY));
  assert.equal(sets.length, 0);
});

test('groupIntoSets DROPS a COMPLETE neg-risk group whose legs have no known fee rate', () => {
  // Distinct from the incomplete case: the group is fully populated, so it looks
  // tradeable, and only the unknown rate makes it unpriceable. Pricing it would compare
  // a fee-free cost against a $1 payout on markets the venue does charge for.
  const unmapped = REAL_NEG_RISK.map((m) => ({ ...m, feeType: 'general_fees' }));
  const { sets, dropped } = groupIntoSets(unmapped.flatMap(normalizeMarket), { withDrops: true });
  assert.equal(sets.length, 0);
  const negDrops = dropped.filter((d) => d.kind === KIND_NEG_RISK);
  assert.equal(negDrops.length, 1);
  assert.equal(negDrops[0].reason, 'unmapped_fee_type');
  assert.equal(negDrops[0].eventKey, NEG_RISK_ID);
});

test('a fee-EXEMPT neg-risk group is priceable, not dropped', () => {
  // The fee-free bucket is where taker arbitrage still works cleanly, so it must not be
  // confused with the unmapped bucket. Both have no rate in `feeType`; only one is free.
  const exempt = REAL_NEG_RISK.map((m) => ({ ...m, feeType: null, feesEnabled: false }));
  const sets = groupIntoSets(exempt.flatMap(normalizeMarket));
  const neg = sets.filter((s) => s.kind === KIND_NEG_RISK);
  assert.equal(neg.length, 1);
  assert.equal(neg[0].legs[0].category, 'geopolitics');
  assert.equal(neg[0].legs[0].feeRate, 0);
  // and it prices at exactly zero fee through the shared engine
  assert.equal(feeFnFor(neg[0].legs[0])(0.5), 0);
});

test('groupIntoSets reports why each dropped group was dropped', () => {
  const [yesOnly] = normalizeMarket(REAL_NEG_RISK[0]);
  const { sets, dropped } = groupIntoSets([yesOnly, ...normalizeMarket(REAL_BINARY)], {
    withDrops: true,
  });
  assert.equal(sets.length, 0);
  // Three drops from two inputs, because a lone neg-risk YES row fails BOTH ways: it is
  // half a binary pair AND a one-member neg-risk group. Both are reported, since they
  // call for different responses (wait for the sibling token vs discover the rest of the
  // group).
  const reasons = dropped.map((d) => d.reason).sort();
  assert.deepEqual(reasons, ['incomplete_binary', 'incomplete_neg_risk', 'unmapped_fee_type']);
  assert.deepEqual(
    dropped.map((d) => d.kind).sort(),
    [KIND_BINARY, KIND_BINARY, KIND_NEG_RISK].sort(),
  );
});

// ── bookTopFromBook ─────────────────────────────────────────────────────────

test('bookTopFromBook takes the LAST level on both sides — the best price', () => {
  // The trap this test exists for: bids ascend and asks descend, so bids[0] is the
  // WORST bid (0.001) and asks[0] the worst ask (0.999). Gamma independently reported
  // bestBid 0.193 / bestAsk 0.194 for this token at capture time.
  const top = bookTopFromBook(REAL_BOOK);
  closeTo(top.bestBid, 0.193, 'bestBid');
  closeTo(top.bestAsk, 0.194, 'bestAsk');
  closeTo(top.bidSize, 419.95, 'bidSize');
  closeTo(top.askSize, 34612.41, 'askSize');
  assert.equal(
    top.tokenId,
    '54533043819946592547517511176940999955633860128497669742211153063842200957669',
  );
  assert.equal(top.ts, 1785495025805);
});

test('bookTopFromBook never returns a crossed or inverted top from real ordering', () => {
  const top = bookTopFromBook(REAL_BOOK);
  assert.ok(top.bestBid < top.bestAsk, 'bid must be below ask');
});

test('bookTopFromBook handles an empty side without inventing a price', () => {
  const noBids = bookTopFromBook({ ...REAL_BOOK, bids: [] });
  assert.equal(noBids.bestBid, null);
  assert.equal(noBids.bidSize, null);
  closeTo(noBids.bestAsk, 0.194, 'ask still read');

  const noAsks = bookTopFromBook({ ...REAL_BOOK, asks: [] });
  assert.equal(noAsks.bestAsk, null);
  assert.equal(noAsks.askSize, null);

  const empty = bookTopFromBook({ ...REAL_BOOK, bids: [], asks: [] });
  assert.equal(empty.bestBid, null);
  assert.equal(empty.bestAsk, null);
});

test('bookTopFromBook handles missing side arrays entirely', () => {
  const top = bookTopFromBook({ asset_id: 'tok', timestamp: '1' });
  assert.equal(top.bestBid, null);
  assert.equal(top.bestAsk, null);
  assert.equal(top.ts, 1);
});

test('bookTopFromBook rejects a level whose price or size is not a usable number', () => {
  for (const bad of [{ price: 'abc', size: '1' }, { price: '0.5', size: 'abc' }, {}]) {
    const top = bookTopFromBook({ ...REAL_BOOK, bids: [bad] });
    assert.equal(top.bestBid, null, JSON.stringify(bad));
  }
});

test('bookTopFromBook tolerates a book with no asset_id', () => {
  assert.equal(bookTopFromBook({ bids: [], asks: [] }).tokenId, null);
  assert.equal(bookTopFromBook({ ...REAL_BOOK, timestamp: undefined }).ts, null);
});

test('bookTopFromBook rejects a non-object book', () => {
  for (const bad of [null, undefined, 'x']) {
    assert.throws(() => bookTopFromBook(bad), /book must be an object/, String(bad));
  }
});

// ── feeFnFor ────────────────────────────────────────────────────────────────

test('feeFnFor wires the row category into the shared fee engine', () => {
  const [yes] = normalizeMarket(REAL_NEG_RISK[0]);
  const fee = feeFnFor(yes);
  // politics: 0.04 * 0.5 * 0.5 = 0.01
  closeTo(fee(0.5), 0.01, 'politics fee at 0.50');
});

test('feeFnFor surfaces the fee engine throw for an unmapped category, never a zero fee', () => {
  const [yes] = normalizeMarket(REAL_BINARY); // general_fees -> category null
  assert.throws(() => feeFnFor(yes), /unknown Polymarket category/);
});

// ── discoverMarkets ─────────────────────────────────────────────────────────

test('discoverMarkets normalizes a paged Gamma response using an injected fetch', async () => {
  const pages = [[REAL_NEG_RISK[0], REAL_NEG_RISK[1]], []];
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => pages.shift() ?? [] };
  };
  const rows = await discoverMarkets({ fetchImpl, pageSize: 2, maxPages: 5 });
  assert.equal(rows.length, 4, 'two markets x two tokens');
  assert.ok(urls[0].startsWith('https://gamma-api.polymarket.com/markets?'), urls[0]);
  assert.ok(urls[0].includes('closed=false'), urls[0]);
  assert.equal(urls.length, 2, 'stops on the first empty page');
});

test('discoverMarkets stops at maxPages instead of paging forever', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => [REAL_NEG_RISK[0]] };
  };
  await discoverMarkets({ fetchImpl, pageSize: 1, maxPages: 3 });
  assert.equal(calls, 3);
});

test('discoverMarkets throws on a non-OK response instead of returning a short list', async () => {
  // A silently truncated market list means missing legs, and a neg-risk set priced
  // without every outcome is priced too cheaply.
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(
    () => discoverMarkets({ fetchImpl }),
    /Polymarket discovery failed: HTTP 503/,
  );
});

test('discoverMarkets throws when the payload is not the array the API documents', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ error: 'nope' }) });
  await assert.rejects(() => discoverMarkets({ fetchImpl }), /expected an array of markets/);
});

test('discoverMarkets requires an injectable fetch so tests never hit the network', async () => {
  await assert.rejects(
    () => discoverMarkets({ fetchImpl: 'not a function' }),
    /fetchImpl must be a function/,
  );
});
