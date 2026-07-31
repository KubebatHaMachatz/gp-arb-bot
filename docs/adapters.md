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
| **Polymarket** | ✅ | ✅ | ⛔ category not derivable | ✅ grouping | ✅ none needed | BLOCKED (A-5) |
| **Kalshi** | ❓ | ❓ | ✅ fees | ❓ | ❓ | not started (A-8) |
| **Limitless** | ❓ | ❓ | ✅ fees | ❓ | ❓ | not started (A-9) |

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

### ⛔ BLOCKER — the fee category is NOT derivable from the read path

`lib/fees.mjs` needs a category (`politics`, `crypto`, …) to pick the taker rate. **No
such field exists** on either the Gamma or the CLOB market object. What exists instead:

1. **`tags`** — free-form editorial labels (`['Politics', 'Elections', 'Global
   Elections', 'Ethiopia', 'Main Election']`). Not a fee enum. Measured against 1000
   live markets:
   - **37 markets carry no `lib/fees.mjs` category name in their tags at all** — e.g.
     `['Business','AI','IPOs','Big Tech']`, `['Fed','Fed Rates','Economy','Macro Single',…]`,
     `['Pandemics','World','Climate & Science']`.
   - Worse, tags **cross-cut actual fee status**: `'Politics'` appears on **45 of the 66**
     markets the venue charges **nothing** for *and* on **544 of the 934** it does charge.
     A tag→category mapping would therefore assign a non-zero rate to genuinely fee-free
     markets and vice versa — silently, in both directions.
   - Tags are also multi-valued and unordered for this purpose; a market tagged both
     `Politics` and `Crypto` has no defined winner.
2. **`taker_base_fee` / `maker_base_fee`** — present per market, and they **partition the
   universe exactly the way the fee schedule implies**: `0` on 66 markets, `1000` on 934,
   and the 66 are overwhelmingly geopolitical (`Geopolitics` 48, `World` 34, plus Middle
   East / Israel / Venezuela / Russia / Iran), matching [ANALYSIS.md](../ANALYSIS.md)'s
   "geopolitics is still fee-free". **But the units are ❓ and the field is not safe to
   read as the taker rate**: `taker_base_fee` is *identical* to `maker_base_fee` on every
   market sampled, and Polymarket charges takers while rebating makers — so a value equal
   on both sides is not a per-side rate. `1000` also matches none of the published rates
   (0.04 / 0.05 / 0.07) under any obvious scaling.
3. **`GET /fees`** — the documented "fee schedule per instrument type and category"
   endpoint is `api.perpetuals.polymarket.com/v1/info/fees`, for **perpetual futures**
   (categories equity / commodity / index / crypto). A **different product**; it does not
   describe event contracts. `clob.polymarket.com/fees` and `/fee-schedule` are 404.
4. Gamma reports `feesEnabled: false` and `feeType: null` on every market in the sampled
   neg-risk event, which is a *third* signal that does not obviously reconcile with the
   published per-category schedule.

**Consequence — the adapter is not written.** Guessing a tag→category mapping is exactly
the failure `lib/fees.mjs` was built to prevent: a wrong rate does not produce a slightly
wrong number, it manufactures or destroys edge silently, and the measurement above shows
a tag-based guess would be wrong in both directions on real markets. Per CLAUDE.md §0
this stays ❓ until pinned against a primary source. **Operator decision required — see
the open question below.**

### ❓ Open questions blocking A-5

- What are `taker_base_fee` / `maker_base_fee` denominated in, and is either the
  effective per-market taker rate? (If yes, this is *better* than a category lookup — it
  is the venue's own per-market ground truth and would remove the category concept from
  the adapter entirely.)
- Is there any authenticated or undocumented endpoint that returns a market's fee
  category / effective rate?
- Does `feesEnabled: false` mean this market charges no taker fee today, overriding the
  published category schedule?

### ✅ Auth

Every read used above — Gamma events, CLOB `/markets/{conditionId}`,
`/sampling-markets` — returned HTTP 200 with **no credentials**. Nothing on the read path
needs auth, as assumed.

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
