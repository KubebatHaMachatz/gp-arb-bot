# CLAUDE.md — gp-arb-bot

> Single source of truth for this repo. Read this before touching anything.
>
> **What this is:** a single-venue, complete-set arbitrage bot for prediction markets.
> Buy every outcome of one event on one venue for less than $1, merge the complete set
> back into collateral for exactly $1. Same venue, same oracle, same resolution event →
> no settlement risk; the merge is immediate → no capital lockup.
>
> **What this is not:** cross-venue arbitrage (different resolution criteria, measured at
> 5.01% disagreement between Polymarket and Kalshi in the sibling repo — fatal to a
> thin-edge trade), and not directional trading of any kind.
>
> Why this shape and not the "Bregman projection / Frank-Wolfe" one that circulates in
> trading content: [ANALYSIS.md](ANALYSIS.md). Build order: [PLAN.md](PLAN.md).

---

## 0. Rules for anyone (human or AI) working in this repo

- **TDD, strictly test-first.** Write the failing test, then the code. **Hand-computed
  oracles only** — never derive an expected value by calling the code under test, and
  never let a test helper build an *output*. Helpers build inputs.
- **Every change goes through a PR.** No direct commits to `main` after the seed commit.
  A PR is reviewed to convergence (nothing above Low severity) before it merges.
- **Never commit credentials or data.** `.env`, `*credentials*`, `*.pem`/`*.key`,
  `data/`, `*.db*`, `*.csv`, `*.bak` are gitignored. Venue keys are read from env only —
  never hardcoded, never logged, never echoed into a launchd plist (plists are
  world-readable 644).
- **Zero runtime dependencies.** Node ≥22.5 builtins only (`node:sqlite`, `node:http`,
  `node:test`, `fetch`). **One scoped exception, and not before A-11:**
  `@noble/curves` (pinned exact, no `^`/`~`) for the signing path, because `node:crypto`
  has neither Keccak-256 (its `sha3-256` is a *different* function — different padding,
  different digest) nor ECDSA-with-recovery over secp256k1 (only ECDH). Dev tooling
  (Stryker) is invoked via `npx`, never added to `dependencies`.
- **Verify-first for every venue fact.** Before writing `lib/adapters/<venue>.mjs`, its
  API facts — discovery, book shape, fee/rebate/tick, auth, merge/convert mechanics —
  must be confirmed against the venue's **primary** docs or a live endpoint and logged in
  [docs/adapters.md](docs/adapters.md). Nothing is coded from memory or from secondary
  sources; a ❓ stays a ❓ until pinned. Third-party guides in this space are frequently
  wrong (ANALYSIS.md §5 documents one that gets the fee arithmetic backwards).
- **Coverage stays maximal.** `npm run coverage` (line/branch) and `npm run mutate`
  (Stryker) are the bar. A new mutation survivor is a real gap until proven equivalent in
  writing.
- **Merging execution code is not arming it.** Everything in Phase 2 ships inert.

---

## 1. Two phases, and the gate between them

| Phase | Items | Places orders? |
|---|---|---|
| **1 — Measurement** | A-1 … A-10 | **No.** No credentials, no order code path exists. |
| **2 — Execution** | A-11 … A-14 | Yes, but **inert by default** behind independent arm switches. |

**The gate:** Phase 2 does not begin until Phase 1 has ≥1 week of live scanning showing a
post-fee, depth-cleared opportunity rate that justifies the capital. If it does not, the
project stops at A-10 having cost a week and no money. That is the system working, not a
failure.

---

## 2. Architecture

```
   venue APIs (WS / Socket.IO / REST order books)
            │
            ▼
   scripts/scan_polymarket.mjs ─┐
   scripts/scan_kalshi.mjs      ├─►  data/arb.db   (venue-tagged SQLite, WAL)
   scripts/scan_limitless.mjs  ─┘
   (lib/scanner_<venue>.mjs + lib/adapters/<venue>.mjs
    → lib/arb.mjs detection ← lib/fees.mjs)
            │
            ▼
   server.mjs + public/  →  opportunity density, post-fee edge distribution,
                            depth-cleared counts        (http://localhost:4324)
            │
            ▼  [Phase 2 only, inert by default]
   lib/broker.mjs (gated executor) → lib/settle.mjs (merge / convert / redeem)
```

- **One scanner process per venue**, each its own OS process and launchd service, so a
  stalled feed on one venue never touches another.
- **Adapter pattern:** venue-specific knowledge lives *only* in `lib/adapters/<venue>.mjs`.
  Detection, sizing, persistence and the dashboard never branch on venue name.
- **Pure core:** `lib/fees.mjs` and `lib/arb.mjs` are pure functions with no I/O. They are
  where the money is decided, so they are the most heavily tested code in the repo.

---

## 3. The two facts everything else follows from

**Fees are quadratic and vanish at the tails.** Both Polymarket and Kalshi charge
`fee = C × feeRate × p × (1−p)` on takers only. A complete set at 0.90/0.05 costs ~0.55¢
in fees where one at 0.50/0.45 costs ~2.0¢ — a 3.6× difference. **The detection threshold
is therefore a function of the leg prices, never a flat constant.** Limitless instead uses
a hand-tabulated, direction-dependent curve that no single scalar can represent safely.

**Capacity is share-constrained, not dollar-constrained.** An arb locks $1 per share-*set*,
so size is `min(sharesᵢ) × Σ costᵢ`. Taking `min(dollars)` understates the cheap leg and
silently oversizes the trade.

---

## 4. Configuration

`GPA_` prefix (siblings on this machine use `PMM_`/`KRO_`/`SPB_`/`WEATHERBOT_`/
`OPENRANGE_`/`BREAKOUT_BOT_`). Every knob is validated at startup and **throws** on a bad
value — no silent fallback to a default.

Ports claimed by this repo on this machine (registered in `~/code/bot_ports.txt`):

| What | Port |
|---|---|
| Singleton lock block | **43241–43249** |
| Dashboard | **4324** |

Before claiming any new port anywhere on this machine: check `~/code/bot_ports.txt`
first, then `lsof`, then grep every sibling repo's source for the literal number. `lsof`
only proves a port is free *right now*; a source grep proves nobody else claims it.

---

## 5. Testing

```bash
npm test          # full suite (Node >= 22.5)
npm run coverage  # native line/branch coverage per lib file
npm run mutate    # Stryker mutation score → reports/mutation/mutation.html
```

The `mutate` glob in `stryker.config.mjs` must stay `lib/**/*.mjs`. The narrower
`lib/*.mjs` silently excludes every subdirectory while still reporting a healthy-looking
score — a sibling repo shipped exactly that bug and trusted the number for two phases.

---

## 6. Relationship to sibling repos

[`prediction-market-mm`](../prediction-market-mm) is the closest relative: two-sided market
making and **cross-venue** arb on short-horizon crypto up/down markets. Different thesis,
different trade, deliberately separate codebase. Its `docs/adapters.md` is a verified-facts
goldmine for all three venues and its `docs/live-risks.md` is the risk register this repo's
Phase 2 inherits — read both before building an adapter or the executor. Its measured
finding that Polymarket↔Kalshi settlement disagrees 5.01% of the time is the direct reason
this repo is single-venue only.
