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
| **Polymarket** | ❓ | ❓ | ✅ fees | ❓ | ❓ | not started (A-5) |
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
