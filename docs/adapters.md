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
| **Polymarket** | ❓ | ❓ | ❓ | ❓ | ❓ | not started (A-5) |
| **Kalshi** | ❓ | ❓ | ❓ | ❓ | ❓ | not started (A-8) |
| **Limitless** | ❓ | ❓ | ❓ | ❓ | ❓ | not started (A-9) |

No adapter code exists yet. Each row is filled in by its own verify-first spike, logged
below, before the corresponding item in [PLAN.md](../PLAN.md) is built.

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
