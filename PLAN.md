# Build plan — gp-arb-bot

> Written 2026-07-31. Derived from [ANALYSIS.md](ANALYSIS.md)'s conclusions and from the
> operational lessons already paid for in the sibling
> [`prediction-market-mm`](../prediction-market-mm) repo.
>
> Every item lands as **its own PR**, built test-first, reviewed to convergence
> (`/code-till-merge`: iterate until a review pass finds nothing above **Low** severity),
> then merged. Items are strictly ordered — each consumes the one before it.

## The thesis, in one paragraph

Buy every outcome of a single event on a single venue for less than $1, then merge the
complete set back into collateral for exactly $1. Same venue, same oracle, same
resolution event, so there is no settlement risk; the merge is immediate, so there is no
capital lockup. This is the shape that produced 99.76% of the $39.6M measured on
Polymarket. The work is not the math — it is fee-aware thresholding, depth-aware sizing,
non-atomic leg-failure handling, and capital recycling.

## Two phases, and the gate between them

**Phase 1 (A-1 … A-10) places no orders.** It is a measurement system: it records how many
opportunities clear a *post-fee* threshold *and* have real depth behind them. Its output
is the evidence for a go/no-go.

**Phase 2 (A-11 … A-14) adds execution**, inert by default behind independent arm
switches. Merging execution code is not arming it.

> **The gate:** Phase 2 does not begin until Phase 1 has ≥1 week of live scanning showing
> a post-fee, depth-cleared opportunity rate worth the capital. If it does not, the
> project stops at A-10 having cost a week and no money.

---

## Phase 1 — Measurement

### A-1 — Repo bootstrap
Scaffold and working rules. `package.json` (Node ≥22.5, ESM `.mjs`, zero runtime
dependencies, `node:test`), `CLAUDE.md` (the rules any AI/human follows here),
`ANALYSIS.md`, this plan, smoke test. Claim the singleton-lock port block
**43241–43249** and dashboard port **4324** in `~/code/bot_ports.txt` — the machine-wide
registry, which nominates exactly this block as next-free.

### A-2 — Config, schema, DB
`lib/config.mjs` — `GPA_*` env with validation that fails fast (a bad knob must throw at
startup, never silently fall back). `schema.sql` — `markets`, `books`, `opportunities`,
`legs`. `lib/db.mjs` — `node:sqlite`, WAL, `busy_timeout`, read-only handle support.

### A-3 — Fee engine `lib/fees.mjs`
The piece the source post gets wrong and everything downstream depends on.
`polymarketTakerFee(price, category)` = `feeRate · p · (1−p)` with the real per-category
table; `kalshiTakerFee(price)` = `0.07 · p · (1−p)`; `limitlessTakerFee(price, side)` —
the genuine hand-tabulated, direction-dependent curve by linear interpolation, clamped at
the table ends. Plus `completeSetCost(legs)` summing per-leg price + fee. Pure functions,
hand-computed test oracles only.

### A-4 — Arbitrage core `lib/arb.mjs`
`binaryComplementEdge({yesAsk, noAsk, feeFn})` → net edge per complete set.
`negRiskSetEdge({asks[], feeFn})` → the multi-outcome case (the $29M bucket).
`setCapacity({legs})` → **share-constrained**: `min(sharesᵢ) × Σ costᵢ`, never
`min(dollars)`. `clearsThreshold(edge, cfg)` → fee-aware and price-aware, not a flat
constant. Pure; no I/O.

### A-5 — Polymarket adapter `lib/adapters/polymarket.mjs`
Verify-first: every API fact pinned against `docs.polymarket.com` and logged in
`docs/adapters.md` before any code. Market discovery including **neg-risk set grouping**
(which conditions belong to one mutually-exclusive event), book normalization, per-market
category → `feeRate` resolution, `wsUrl` + subscribe payload.

### A-6 — Polymarket scanner `lib/scanner_polymarket.mjs` + `scripts/scan_polymarket.mjs`
Live WS book maintenance, in-memory complete-set detection on every book update, a
freshness gate (~750ms), depth-aware sizing from the live ladder, and a row written per
detected opportunity. **Read-only against the venue** — it holds no credentials and has
no code path that can place an order. Carries the known Polymarket trap: a
mid-connection resubscribe is a **no-op**, so a token-set rotation must force a reconnect
or the rotated-in token silently streams nothing.

### A-7 — Dashboard + JSON API `server.mjs` + `public/`
Opportunity density per day, post-fee edge distribution, depth-cleared vs raw counts,
per-category breakdown (the geopolitics 0%-fee bucket reported separately — it is
structurally different), time-to-decay per opportunity. Loopback-bound by default.

### A-8 — Kalshi adapter + scanner
REST-poll (its WebSocket requires auth even to connect). Its book is **bids-only on both
sides** — a `no_dollars` bid at `q` is a YES ask at `1−q`; reducing to `{bids, asks}`
needs that transform, not a reuse of Polymarket's reducer. Tapered tick (0.001 / 0.010 /
0.001 by price band). No maker rebate exists anywhere in its schedule.

### A-9 — Limitless adapter + scanner
Socket.IO (**not** a raw WebSocket) at `wss://ws.limitless.exchange`, namespace
`/markets` — the default namespace connects and yields nothing. Full book snapshot per
`orderbookUpdate`. Sizes scale by 1e6. The A-3 fee curve applies here.

### A-10 — Operational hardening
`lib/singleton.mjs` (port-bind lock, one per writer process), `lib/watchdog.mjs` +
`scripts/watchdog.mjs` (per-venue feed staleness with per-feed thresholds; de-duplicated
kicks), `lib/notify.mjs` (Telegram, **inert** unless both env vars are set, never throws,
always reports its own send failures), payload contract-drift detection (an *absent key*
is drift; a key present with a *null value* is normal data), launchd install/uninstall.

---

## Phase 2 — Execution (gated; begins only after the Phase 1 gate passes)

### A-11 — Signing primitives
`lib/eip712.mjs` (`@noble/curves`, pinned exact — the one allowed runtime dependency,
because `node:crypto` has neither Keccak-256 nor ECDSA-with-recovery over secp256k1),
verified against the **third-party** MetaMask/eth-sig-util reference vector rather than
self-consistency. `lib/polymarket_auth.mjs` (L1 `ClobAuth` EIP-712 → L2 HMAC, 5 `POLY_*`
headers). `lib/polymarket_order.mjs` (the V2 **11-field** struct — structurally different
from the classic 12-field one, not a copy).

### A-12 — Executor `lib/broker.mjs`
Inert by default. Independent arm switches (env var **and** a runtime arm file **and** a
per-venue enable). N legs fired in **parallel** as IOC/FAK **limit** orders at observed
prices — never market, so a moved book yields a non-fill rather than a worse fill.
Write-ahead intent journal persisted *before* leg 1 is sent; startup reconciliation
against **venue truth** (the open-orders/positions API), never local DB state. A written,
mechanical unwind policy for partial sets. Per-event size cap, daily loss cap that
disarms, kill switch.

### A-13 — Capital recycling `lib/settle.mjs`
`mergePositions` for binary complete sets, NegRiskAdapter `convert` for neg-risk sets,
`redeemPositions` sweep for anything held to resolution. Balance-aware arming: the engine
knows its free collateral and **records** every skip with the foregone modeled profit, so
capital starvation is visible rather than silently biasing capture toward early in the day.

### A-14 — Honesty metrics + go/no-go
Capture ratio (filled ÷ modeled capturable), realized − modeled net edge per set, leg
failure rate, per-venue fill honesty (filled ÷ displayed at intent), recycle lag, and the
arming-ladder state. The weekly review that catches edge decay — the failure mode where a
strategy quietly stops working and the only wrong response is loosening thresholds to keep
trade count up.

---

## Working rules (enforced on every item)

- **TDD, strictly test-first.** Failing test, then code. Hand-computed oracles only —
  never derive an expected value by calling the code under test.
- **Every change is a PR**, reviewed to convergence before merge. No direct commits to
  `main` after the seed.
- **Verify-first for every venue fact.** Nothing coded from memory or from secondary
  sources; a ❓ stays a ❓ until pinned against the primary source, and gets logged in
  `docs/adapters.md`.
- **Zero runtime dependencies**, except `@noble/curves` (pinned exact) scoped to the
  signing path in A-11 and below.
- **Never commit credentials or data.** Keys live in `.env` (0600, gitignored), read from
  env only, never logged.
- **Merging execution code is not arming it.** Arming is an explicit operator action.
