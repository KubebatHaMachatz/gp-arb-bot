# Venue adapters — verified facts log

Each venue adapter is written **only after** its API facts are verified against the
venue's own primary documentation or a live endpoint. This file is that record.

**Nothing here may rest on a secondary source.** Third-party guides in this space are
frequently and confidently wrong — [ANALYSIS.md](../ANALYSIS.md) §5 documents a widely
cited arbitrage tutorial whose worked example concludes a losing trade is profitable
because it forgot that per-contract fees scale with size. A fact from a blog post, an SDK
README, or an AI summary is a **lead**, not a fact; it becomes a fact when the venue's own
docs or a live response confirms it.

Anything unverified is marked ❓ and must be confirmed before the code that depends on it
is written.

## What must be pinned, per venue

- **Discovery** — how to list markets, and how to know which conditions form one
  **mutually-exclusive set** (the neg-risk grouping). Complete-set arbitrage is undefined
  without this.
- **Order book** — WS vs Socket.IO vs REST-poll; full-snapshot vs incremental; the exact
  message schema; whether both sides are quoted or one side must be derived.
- **Economics** — taker fee formula (with its real shape, not a convenient scalar), maker
  fee/rebate, tick size, minimum order size **and its units** (shares vs dollar notional).
- **Complete-set mechanics** — how a full set is merged/converted back into collateral,
  which contract does it, who pays gas, and whether it requires resolution first. This is
  what makes the trade capital-efficient; an adapter without it is incomplete.
- **Auth** — what read access needs (ideally nothing), and what execution needs later.
- **Rate limits** — on the read path and, separately, the order path.

## Status

| Venue | Discovery | Book | Economics | Complete-set mechanics | Auth (reads) | Adapter |
|---|---|---|---|---|---|---|
| **Polymarket** | ✅ | ✅ | ✅ via `feeType` | ✅ grouping, but see the ⚠️ | ✅ none needed | ✅ A-5 |
| **Kalshi** | ✅ | ✅ | ✅ single rate | ✅ grouping | ✅ none needed | ✅ A-8 — but see the ⚠️ |
| **Limitless** | ✅ spiked | ❓ | ✅ curve | ❓ | ✅ none needed | ⏸ A-9 — scope questioned, see below |

No adapter code exists yet. Each row is filled in by its own verify-first spike, logged
below, before the corresponding item in [PLAN.md](../PLAN.md) is built.

## Fee schedules — ✅ VERIFIED 2026-07-31 (implemented in `lib/fees.mjs`)

The one section of this file that has graduated from lead to fact. Pinned against each
venue's own published schedule, not a third-party summary.

### The two fee SHAPES are not interchangeable

| Venue | Shape | Per-share fee |
|---|---|---|
| Polymarket | quadratic, per share | `rate × p × (1 − p)` |
| Kalshi | quadratic, per share | `0.07 × p × (1 − p)` |
| **Limitless** | **rate on NOTIONAL** | **`rate(p, side) × p`** |

Conflating them is the error class [ANALYSIS.md](../ANALYSIS.md) documents. Two
consequences that drive real design decisions:

1. **`p(1−p)` shrinks toward the price extremes.** A Polymarket politics complete set at
   0.50/0.45 costs `0.04·0.25 + 0.04·0.2475 = 0.0199` (~2.0¢); the same set at 0.90/0.05
   costs `0.04·0.09 + 0.04·0.0475 = 0.0055` (~0.55¢). **3.62× cheaper.** The detection
   threshold is therefore a function of the leg prices, never a flat constant.
2. **Limitless never decays to zero.** At p=0.999 Polymarket's crypto fee is
   ~0.00007/share while Limitless holds a ~0.40% floor. No finite scalar bounds the
   ratio, so no flat `feeRate` can safely stand in for the curve.

### Polymarket — taker only, makers pay zero and earn rebates

Source: <https://docs.polymarket.com/trading/fees>. Formula `fee = C × feeRate × p × (1 − p)`.

| Category | `feeRate` |
|---|---|
| crypto | 0.07 |
| sports, economics, culture, weather, other | 0.05 |
| politics, finance, tech, mentions | 0.04 |
| **geopolitics / world events** | **0** |

Geopolitics being genuinely fee-free is a fact about the schedule, not an unmapped
category — it is where taker arbitrage still works cleanly, and therefore where
competition concentrates. `lib/fees.mjs` **throws** on any category outside this table
rather than defaulting to zero; a zero-fee fallback would understate cost and manufacture
arbitrage that does not exist.

### Kalshi — taker only, and NO maker rebate anywhere in the schedule

Sources: <https://kalshi.com/fee-schedule>, <https://docs.kalshi.com/getting_started/fee_rounding>.
`fee = 0.07 × C × p × (1 − p)`, **side-independent** (a NO buy at `1−p` is algebraically
the YES fee at `p`), rounded up to the nearest $0.0001.

Structurally unlike the other two: a Kalshi maker either pays a maker fee (non-standard
series) or pays nothing — **no series pays the maker**. There is a separate designated
market-maker programme, but it is application-gated and not something a retail quoter
earns by default.

❓ Still unverified for this repo's market class: the tapered tick (0.001 / 0.010 / 0.001
by price band) was verified for 15-minute crypto series in the sibling repo and has not
been re-checked against multi-outcome event markets.

### Limitless — taker only, makers rebated 100% of eligible taker fees

Source: <https://docs.limitless.exchange/user-guide/fees>. The docs publish a **table, not
a formula**; `lib/fees.mjs` interpolates linearly between the published points and clamps
flat outside them.

| p | 0.01 | 0.05 | 0.10 | 0.20 | 0.30 | 0.40 | 0.50 | 0.55 | 0.60 | 0.65 | 0.70 | 0.75 | 0.80 | 0.85 | 0.90 | 0.95 | 0.99 | 0.999 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **BUY** | 3.00% | — | — | — | — | — | 3.00% | 2.52% | 2.13% | 1.80% | 1.51% | 1.26% | 1.05% | 0.85% | 0.68% | 0.53% | 0.42% | 0.40% |
| **SELL** | 0.42% | 0.60% | 0.78% | 1.11% | 1.32% | 1.44% | **1.50%** | — | 1.44% | — | 1.32% | — | 1.11% | — | 0.78% | 0.60% | 0.45% | 0.42% |

The two curves are **not mirror images** and their ordering inverts: at p=0.50 BUY costs
2× SELL, but by p=0.90 SELL is the dearer side. `limitlessTakerFee` therefore **requires**
an explicit side rather than defaulting one.

## Polymarket — read-path spike, 2026-07-31 (A-5)

Live against the public endpoints, no auth used or needed. **Everything structural
verified; the fee category did NOT verify and blocks the adapter — see the ⛔ below.**

### ✅ Set grouping — the single most important fact, and it is confirmed

A Polymarket neg-risk set is **not** one market with N outcomes. Each outcome is its
**own binary market**, with its own `conditionId` and its own YES/NO token pair. What
ties them into one mutually-exclusive set is **`neg_risk_market_id`** (CLOB) /
**`negRiskMarketID`** (Gamma), identical strings.

Live sample — event `next-prime-minister-of-ethiopia` (`negRisk: true`,
`negRiskMarketID: 0x55ab76…6500`) contains **33 markets**, each `outcomes:
["Yes","No"]`. So:

| Complete set | Grouped by | Legs |
|---|---|---|
| **binary** | `conditionId` | the YES + NO of that one market |
| **neg_risk** | `negRiskMarketID` | the **YES token of every market** in the group |

`negRiskAugmented: true` events carry an explicit **`negRiskOther: true`** market
("Other", exactly 1 of the 33 above). That leg is part of the complete set — omitting it
would understate the cost of covering every outcome.

Sources: <https://docs.polymarket.com/concepts/negative-risk>, live
`GET https://gamma-api.polymarket.com/events?closed=false`,
`GET https://clob.polymarket.com/markets/{conditionId}`.

### ✅ Discovery and market metadata

- **Gamma** `GET https://gamma-api.polymarket.com/events?closed=false&limit=&order=` —
  events with a nested `markets[]` array. Public, no auth (HTTP 200 unauthenticated).
- **CLOB** `GET https://clob.polymarket.com/markets/{conditionId}` — per-market detail;
  `GET /sampling-markets` returns 1000 markets in one call. Public, no auth.
- Fields confirmed present and populated on live data:

| Need | Gamma | CLOB |
|---|---|---|
| condition id | `conditionId` | `condition_id` |
| token ids | `clobTokenIds` (JSON **string** of `[YES, NO]`) | `tokens[].token_id` |
| outcome labels | `outcomes` (JSON **string** `'["Yes", "No"]'`) | `tokens[].outcome` |
| neg-risk group | `negRiskMarketID` | `neg_risk_market_id` |
| tick size | `orderPriceMinTickSize` | `minimum_tick_size` |
| min order size | `orderMinSize` | `minimum_order_size` |
| set-member label | `groupItemTitle` | — |

- **`minimum_order_size` is `5` on all 1000 sampled markets.** Units re-confirmed as a
  **share count** (consistent with the sibling repo's live size-rejection finding).
- **Tick size varies *within* a single event**: in the Ethiopia event, 8 markets at
  `0.001` and 25 at `0.01`. Across 1000 sampled: 390 at `0.001`, 610 at `0.01`. Tick is
  therefore **per market**, never per event or per venue.
- `neg_risk` is roughly half the universe: 504 of 1000 sampled markets.

### ✅ Fee category — RESOLVED via `feeType` (corrects an earlier reading in this file)

**`feeType` on the Gamma market object is the fee category, stated explicitly** as
`<category>_fees[_v2]`. Enumerated over **500 unique live markets** (2026-07-31):

| `feeType` | count | → `lib/fees.mjs` category | rate |
|---|---|---|---|
| `politics_fees` | 292 | politics | 0.04 |
| `sports_fees_v2` | 65 | sports | 0.05 |
| `crypto_fees_v2` | 50 | crypto | 0.07 |
| `null` | 35 | fee-exempt → `geopolitics` | 0 |
| `tech_fees` | 17 | tech | 0.04 |
| `general_fees` | 15 | ❓ **unmapped** | — |
| `culture_fees` | 10 | culture | 0.05 |
| `weather_fees` | 7 | weather | 0.05 |
| `economics_fees` | 6 | economics | 0.05 |
| `finance_prices_fees` | 3 | finance | 0.04 |

**`feesEnabled === (feeType !== null)` held with zero exceptions** (465 / 35), so a null
`feeType` is the genuinely fee-exempt bucket rather than missing data.

> **Correction.** An earlier pass of this spike concluded the category was underivable.
> That was generalised from a single event (`next-prime-minister-of-ethiopia`) whose 33
> markets all happen to be fee-exempt, so every one of them showed `feeType: null`. A
> broader sample refutes it. The mapping table above is the fact; `tags` and
> `taker_base_fee` are not needed and are not used.

**What is NOT used, and why:**

- **`tags`** — editorial labels that cross-cut real fee status. `'Politics'` appears on
  45 of the 66 markets the venue charges nothing for *and* on 544 of the 934 it does
  charge, and 37 of 1000 markets carry no recognisable category name at all. A tag-based
  mapping would be wrong in both directions.
- **`taker_base_fee` / `maker_base_fee`** — ❓ units unverified, and the two are
  *identical* on every market sampled (0 or 1000). A venue that charges takers while
  rebating makers cannot have one number for both, so this is not a per-side rate.
  Unused, and no longer needed.
- **`GET /fees`** — `api.perpetuals.polymarket.com`, i.e. perpetual futures. A different
  product. `clob.polymarket.com/fees` is 404.

**❓ `general_fees` remains unmapped** (~3% of markets). Its stem is not a category in the
published schedule, so its rate is genuinely unknown. `feeCategoryFor` returns `null` and
`groupIntoSets` **drops** any set containing such a leg, counted as `unmapped_fee_type` —
rather than guessing 0.05, which would understate a 0.07 market and manufacture edge.

### ✅ Order book — level ordering is UNDOCUMENTED, so do not read by position

`GET https://clob.polymarket.com/book?token_id=` — public, no auth. Live response:
**`bids` ascend and `asks` descend**, so index 0 is the *worst* price on each side
(0.001 and 0.999 on the sample) and the best is the final element. Cross-checked against
Gamma's independently reported `bestBid: 0.193` / `bestAsk: 0.194` for the same token at
the same moment. Prices and sizes are **strings**; `timestamp` is a string of epoch ms.
Sizes are **share counts**.

Reading index 0 would misprice every set catastrophically. But the venue documents no
ordering guarantee at all, so `bookTopFromBook` does **not** read by position either — it
scans for `max(bid)` / `min(ask)`, which is correct under any ordering. Tests assert the
captured real response *and* its reversed and shuffled permutations agree.

**Discovery reads `/events`, not `/markets`** — a correctness requirement. An event nests
every member market, so a neg-risk group arrives whole or not at all; paging over
`/markets` can split a 51-member group across a page boundary. `groupIntoSets` checks the
assembled leg count against the group size the event itself declares, and drops on any
mismatch. "At least 2 legs" is not a completeness check: two legs of a 51-outcome race
cost ~$0.39 and would present as a ~60¢ risk-free edge on a set that can never be
redeemed.

### ⚠️ A leg count matching the venue's declared group size is NOT proof of exhaustiveness

The check above (`negRiskGroupSize`) catches a group that is *short*. It cannot catch a
group whose members are individually well-formed but jointly **do not tile the real
outcome space** — every declared leg present, `negRisk: true`, the count matching, and
the set still not exhaustive.

Live example, event `eurozone-2026-annual-inflation` (9 declared members, all 9 present
and active):

| Market | Range |
|---|---|
| `…less-than-1pt0` | (−∞, 1.0) |
| `…between-1pt0-and-1pt2` | [1.0, 1.2] |
| `…between-1pt3-and-1pt5` | [1.3, 1.5] |
| `…between-1pt7-and-1pt9` | [1.7, 1.9] |
| `…between-1pt9-and-2pt1` | [1.9, 2.1] |
| `…between-2pt4-and-2pt5` | [2.4, 2.5] |
| `…between-2pt5-and-2pt7` | [2.5, 2.7] |
| `…between-2pt8-and-3pt0` | [2.8, 3.0] |
| `…at-least-3pt1` | [3.1, ∞) |

1.9 and 2.5 are each claimed by **two** bands; 1.6, 2.2–2.3, and (3.0, 3.1) are claimed by
**none**. If the published rate lands in a gap, every YES leg resolves NO and the
"complete set" this repo bought redeems for **$0**, not $1 — the defining premise of the
whole strategy. Verified against `GET /events/{id}` at query time, not inferred from
slugs alone.

**Consequence: `negRiskMarketID` + a matching leg count is a completeness check on
Polymarket's bookkeeping, not on the real-world outcome space it claims to partition.**
No field in the Gamma or CLOB response asserts the latter, and this repo has no rule
engine capable of parsing a market's resolution text and proving the union of ranges is
gap-free and non-overlapping. Until one exists, `lib/arb.mjs`'s `clearsThreshold` never
lets a `neg_risk` result clear, regardless of its measured edge — see that function's
docstring. The set is still fully **priced** (a real `net_edge`, never hidden or
skipped); it just cannot claim to be a genuine, redeemable arbitrage on this evidence
alone. Binary sets are unaffected: a market resolves YES or NO, always, by construction
— there is no third case for a gap to hide in.

### ✅ Auth

Every read used above — Gamma events, CLOB `/markets/{conditionId}`,
`/sampling-markets` — returned HTTP 200 with **no credentials**. Nothing on the read path
needs auth, as assumed.

## Kalshi — read-path spike, 2026-07-31 (A-8)

Live against the public endpoints, no auth. Everything needed is verified — **and the
verdict on the venue is negative for this strategy on the public path.**

### ✅ Set grouping — an explicit flag, unlike Polymarket

`mutually_exclusive: true` on the **event** is the set marker, and the event nests every
member market (`?with_nested_markets=true`), so a group arrives whole and completeness is
structural. 9 of 20 events in the first page were mutually exclusive; non-exclusive
events carry exactly one market and are plain binaries.

### ✅ The order book is BIDS-ONLY on both sides

`orderbook_fp.yes_dollars` = YES bids, `no_dollars` = NO bids. There are **no ask
queues**. An ask exists only as the mirror of the opposite side's bid:

```
YES ask = 1 − (best NO bid),   size = that NO bid's size
NO  ask = 1 − (best YES bid),  size = that YES bid's size
```

The **size** half is what is easy to get backwards, and getting it backwards prices each
leg correctly while sizing it against the wrong queue. Verified live on
`KXNEWPOPE-70-PPIZ`: best NO bid `0.954 × 1307` and best YES bid `0.040 × 70`; the venue
independently reported `yes_ask 0.0460 / yes_ask_size_fp 1307` and
`no_ask 0.9600 / yes_bid_size_fp 70`. Both ladders **ascend**, so the best is last — the
same trap as Polymarket, handled the same way by scanning for the extreme.

**An empty bid queue mirrors to an ask of exactly 1.00**, which is the absence of an
offer rather than an offer. Found live: it reached the pricing core as a degenerate leg
and threw mid-crawl. Asks outside `(0, 1)` are now treated as no offer.

### ✅ Economics — one rate, no category, no rebate

`0.07 · p · (1−p)`, side-independent. No maker rebate exists anywhere in the schedule, so
unlike Polymarket there is no category to resolve and nothing that can fail to map.

❓ A few series carry `fee_multiplier: 0` and are genuinely free, but that field lives on
the **series** object, not the event or market. Unresolved here; pricing those at the
standard rate **overstates** their cost, which only costs a missed opportunity.

### ⚠️ Discovery is rate-limited, and must be throttled

Paging without a delay returns **HTTP 429 on the second page** — an unthrottled crawl
does not run slowly, it fails outright. Discovery spaces pages by 300ms and retries a 429
with backoff. Pagination is by opaque `cursor`, and a repeated cursor terminates the
crawl (a server echoing one would otherwise page to the limit, multiplying every row).

### ⚠️ VERDICT — the public REST path cannot support this strategy

| | Polymarket | Kalshi |
|---|---|---|
| transport | public WebSocket, pushed | REST crawl (WS needs auth **to connect**) |
| full universe | 3,630 sets | **75,817 sets** |
| time to refresh all | sub-second per update | **~34–54 s per crawl** |
| venue book timestamp | yes, per message | **none** — `updated_time` is the record's mtime, observed a month old |
| sets gated stale | ~3% | **99.8%** (47,816 of 47,931) |

Measured on a real crawl. Rows are stamped with **their own page's** fetch time rather
than the crawl's end, because a row from page 1 really is that stale by the time page 40
lands — that is the only honest age available, and it is what lets the gate do its job
instead of reading ~0 for everything.

The consequence is not a bug to tune away: on a 34-second-old book those sets genuinely
are stale. **The single set that cleared had a capacity of $0.40** — a thin-book artifact,
and a good illustration of why depth-aware sizing is not optional.

Two practical implications:

1. Trading Kalshi on this strategy would need the **authenticated WebSocket**, which is
   out of scope for a read-only measurement phase.
2. Running this scanner continuously is not recommended: 75,817 sets means a crawl writes
   tens of thousands of rows per sampling window. Use `--once` for a point-in-time read.

## Limitless — read-path spike, 2026-07-31 (A-9, partial)

`GET https://api.limitless.exchange/markets/active?limit=25` — public, no auth, HTTP 200.

### ⏸ There are no multi-outcome sets to arbitrage here

Across the whole active universe sampled:

| field | value |
|---|---|
| `marketType` | `single` — **25 of 25** |
| `groupId` | unset on all 25 |
| `negRiskRequestId` | unset on all 25 |
| `isOther` | false on all 25 |
| `tradeType` | `clob` on all 25 |

`GET /markets/groups` returns **400** and `GET /markets` **404**, so no grouped-market
listing is exposed. Every active market is a short-horizon crypto up/down window (`BTC Up
or Down - 5 Min`, `ETH … 15 Min`, `DOGE … Hourly`, …).

**Consequence for this repo.** The neg-risk half of the thesis — the shape that produced
$29M of the measured $39.6M, and the reason this repo groups by event at all — **does not
exist on Limitless**. What remains is the binary YES+NO case on the most contested,
fastest-moving instrument the venue lists.

That is not nothing, but three things make it a poor next target:

1. **Its fee curve is the harshest of the three.** A flat 3.00% on buys below $0.50 means
   a complete set near even odds costs ~3¢ in fees — comparable to Polymarket's *crypto*
   rate, with no fee-free bucket anywhere to offset it.
2. **The instrument is already studied next door.** The sibling
   [`prediction-market-mm`](../../prediction-market-mm) repo exists to measure exactly
   these 5/15-min crypto windows, with a live corpus going back to 2026-07-03.
3. **The transport is the fiddliest.** Socket.IO on a non-default `/markets` namespace
   with Engine.IO framing, versus a plain WebSocket and a REST crawl for the other two.

**Recommendation: reorder.** Finish A-10 (operational hardening) so the Polymarket
scanner — the one venue where the thesis genuinely applies and the data is fresh — can be
left running for the week that gates Phase 2. Revisit Limitless only if that week's
Polymarket numbers justify widening, at which point the binary-only scope should be a
deliberate choice rather than an inherited one.

## Leads to verify (NOT yet facts)

Carried over from the sibling [`prediction-market-mm`](../../prediction-market-mm) repo's
own `docs/adapters.md`, which live-verified them for a *different* purpose (short-horizon
crypto up/down market making). They are strong leads and a good starting point, but this
repo trades a different market class — multi-outcome political/sports/news events rather
than 5- and 15-minute crypto windows — so **every one of them is re-verified here against
the markets this repo actually touches** before any code depends on it.

- Polymarket: taker fee `feeRate · p · (1−p)`, per-category `feeRate`; CLOB matching is
  off-chain via a central operator with on-chain settlement; NegRiskAdapter handles
  multi-outcome conversion; `min_order_size` is a **share count**, not a dollar notional.
- Kalshi: taker fee `0.07 · p · (1−p)`, side-independent; **no maker rebate exists
  anywhere in its schedule**; tapered tick (0.001 / 0.010 / 0.001 by price band);
  orderbook is **bids-only on both sides** — a NO bid at `q` is a YES ask at `1−q`; the
  WebSocket requires auth even to connect, REST reads do not.
- Limitless: taker fee is a hand-tabulated, **direction-dependent** curve (no valid flat
  rate); makers rebated 100% of eligible taker fees; tick 0.001 flat; Socket.IO on the
  **`/markets` namespace** (the default namespace connects and delivers nothing).
