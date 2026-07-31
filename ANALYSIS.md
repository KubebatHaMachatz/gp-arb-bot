# Is the "$40M Polymarket arbitrage" roadmap buildable?

> Source under review: *"The Math Needed for Trading on Polymarket (Complete Roadmap)"*
> by Roan ([@RohOnChain](https://x.com/RohOnChain)), Jan 2026.
>
> Written 2026-07-31. Every claim below was checked against the two academic papers the
> post itself cites, against the venues' own primary documentation, and against the
> measured findings in the sibling [`prediction-market-mm`](../prediction-market-mm) repo.
> Secondary/SEO sources were used only where a venue publishes nothing, and are flagged
> as such.

---

## Verdict

**Buildable and marginally viable — but not by following this roadmap.**

The post's empirical backbone is real and quoted accurately. Its *mathematical*
centerpiece is misattributed: the Bregman-projection / Frank-Wolfe / integer-programming
machinery comes from a paper about a **market maker pricing its own LMSR book**, not
about a trader extracting arbitrage. Polymarket, Kalshi and Limitless are all central
limit order books; there is no cost function for that math to attach to.

The post's own numbers settle it: the combinatorial arbitrage that machinery would serve
was **$94,157 of $39.6M — 0.24%**. The other **99.76%** came from checking whether a list
of prices sums to $1.

Two of the four conditions that produced that money still hold. Fee-free taking does not.

| Condition | Then (Apr 2024 – Apr 2025) | Now (Jul 2026) |
|---|---|---|
| Arithmetic-level detection | ✅ | ✅ still sufficient |
| Fast, automated execution | ✅ | ✅ still required |
| Working capital ($500K+ for the top extractor) | ✅ | ✅ still the binding constraint |
| **Zero taker fees** | ✅ | ❌ **fees since Jan 2026** |

---

## 1. What the post gets right

Verified against [arXiv:2508.03474](https://arxiv.org/abs/2508.03474) — *"Unravelling the
Probabilistic Forest: Arbitrage in Prediction Markets"*, Saguillo, Ghafouri, Kiffer,
Suarez-Tangil (Aug 2025):

| Claim in the post | Paper |
|---|---|
| ~$40M extracted Apr 2024 – Apr 2025 | ✅ $39.6M |
| 17,218 conditions | ✅ across 10,237 markets |
| Top trader $2,009,631.76 / 4,049 trades | ✅ exact |
| DeepSeek-R1-Distill-Qwen-32B at 81.45% | ✅ (101 of 128 markets) |
| $0.05 profit threshold, 950-block (~1h) window | ✅ (75% of bids fell inside it) |
| 13 verified dependent pairs from 374 LLM candidates | ✅ |

The paper is solid work and its category breakdown is a genuine map of where the money
was. Take it seriously.

## 2. The central misattribution

Parts II and III of the post — Bregman divergence, the marginal polytope, Frank-Wolfe,
the IP oracle, Barrier Frank-Wolfe, LCMM vs FWMM, the 2^63 NCAA bracket — all come from
[arXiv:1606.02825](https://arxiv.org/abs/1606.02825), *"Arbitrage-Free Combinatorial
Market Making via Integer Programming"* (Kroer, Dudík, Lahaie, Balakrishnan, 2016).

That paper describes **a market maker setting its own prices so traders cannot arbitrage
it.** From the paper: *"All shares are bought from and sold to the market maker, rather
than between traders, and the market maker uses a convex potential function to determine
current security prices."* It contains no discussion of order books, latency, or exchange
execution.

The post welds it onto the Polymarket paper with lines like *"The top arbitrageur
extracted $2,009,631.76… Their strategy was solving this optimization problem."* **The
Polymarket paper says no such thing.** Its method is *"a heuristic-driven reduction
strategy based on timeliness, topical similarity, and combinatorial relationships."* No
Bregman projection, no Frank-Wolfe, no integer programming appears anywhere in it.

This is structural, not pedantic:

- Bregman divergence `D(μ‖θ)` is defined **relative to a market maker's convex cost
  function `C(θ)`**. That is what makes `θ`, `C`, and the conjugate `R` exist at all.
- Polymarket, Kalshi and Limitless are **all CLOBs**. No LMSR, no cost function, no `θ`.
- So there is no "arbitrage-free manifold of the market" to project onto. There is a book
  with resting orders and finite depth.

## 3. The post's own numbers refute its thesis

Profit breakdown, matching the paper exactly:

```
Single-condition (YES + NO ≠ $1)      $10,581,362     26.7%
Market rebalancing (neg-risk sets)    $29,011,589     73.1%   ← buy-all-NO alone: $17.3M
Combinatorial (cross-market)          $    94,157      0.24%  ← the only place the math applies
                                      ───────────
                                      $39,687,108
```

The combinatorial bucket — the sole category where dependency detection and Bregman
projection would even be *relevant* — is a rounding error, found in 5 of 11 exploitable
pairs. The post spends three of five parts on machinery that produced 0.24% of the money.

## 4. Technical errors that would mislead a builder

**"Direct RPC submission ~15ms (bypass API)."** Architecturally impossible. Polymarket
orders are EIP-712-signed messages sent to a **centralized CLOB operator** that matches
off-chain and submits the trade on-chain itself ([order lifecycle
docs](https://docs.polymarket.com/concepts/order-lifecycle)). You cannot bypass the
matching engine to take liquidity. You control on-chain calls only for
`split`/`merge`/`convert`/`redeem`.

**The latency table is conceptually wrong.** It counts Polygon's ~2s block time as part
of the race. It is not — the race is decided in the operator's queue, off-chain, in
arrival order. On-chain inclusion is asynchronous confirmation of a fill already won or
lost. Note also its own punchline: 2,650ms vs 2,040ms, a 23% difference the post claims
is worth $40M. And "confirming everything in the same block" is not something you control
when the operator submits.

**Internal contradiction.** Part III reports Frank-Wolfe projections taking 30 seconds to
30 minutes. Part IV says winners execute in 30ms. Same system.

**The position-sizing formula is invented.** `f = (b·p − q)/b × sqrt(p)` is not Kelly.
Kelly is `f* = (b·p − q)/b`. The `sqrt(p)` has no derivation and appears in neither paper.

**The execution statistics are unsourced.** "87% success rate; failed due to liquidity
(48%), price movement (31%), competition (21%)" — the paper measures detected
opportunities and realized on-chain profit. It does not attribute failure causes.

**"Median mispricing $0.60 means markets were wrong by 40%"** inverts the meaning. A 40¢
risk-free edge persisting across 41% of conditions is not opportunity, it is **near-zero
depth**. The paper caps profit per opportunity at `deviation × min(volume across required
legs)` for exactly this reason; its own worked example is a 15% edge worth **$35.10
total**. Large apparent edges live where there is nothing to trade against.

## 5. What actually changed: fees

The paper's window was fee-free. Polymarket introduced taker fees in **January 2026**.
Per [Polymarket's own docs](https://docs.polymarket.com/trading/fees):

```
fee = C × feeRate × p × (1 − p)        (takers only; makers pay zero and earn rebates)
```

| Category | feeRate |
|---|---|
| Crypto | 0.07 |
| Sports, Economics, Culture, Weather, Other | 0.05 |
| Politics, Finance, Tech, Mentions | 0.04 |
| **Geopolitics / World events** | **0 — still fee-free** |

For a complete set bought near 50¢, total fee ≈ `feeRate / 2` per $1 of payout:

| Category | fee per complete set | paper-era 5¢ edge becomes |
|---|---|---|
| Politics (0.04) | ~2.0¢ | ~3.0¢ |
| Sports (0.05) | ~2.5¢ | ~2.5¢ |
| Crypto (0.07) | ~3.5¢ | ~1.5¢ |

**Kalshi is worse**: taker fee `0.07 × p × (1−p)`, no maker rebate anywhere in its
schedule — a maker either pays a maker fee or pays nothing, but no series pays the maker
(verified in `prediction-market-mm`'s `docs/adapters.md`). ~3.5¢ per complete set at mid
prices.

**Limitless** charges a hand-tabulated, direction-dependent taker curve (3.00% flat from
$0.01–$0.50 on buys, decaying to 0.40%; sells peak at 1.50% at the midpoint) and rebates
makers **100%** of eligible taker fees. No single scalar `feeRate` can represent it
safely — matching the curve at p=0.5 needs ≈0.06, but that same formula collapses toward
zero near the extremes while the real fee holds a ~0.4% floor.

### Two structural consequences the post would never lead you to

1. **`p(1−p)` means fees vanish at the tails.** A complete set at 0.90/0.05 costs 0.55¢ in
   politics versus 2.0¢ at 0.50/0.45 — a **3.6×** difference. Lopsided markets are
   dramatically cheaper to arb. This is a real, exploitable property of the actual fee
   schedule and it belongs in the detector's threshold, not a flat 5¢ constant.
2. **The edge moved to the maker side.** Makers pay zero and earn rebates. But a
   resting-order strategy is market making with adverse-selection risk — a different
   system with real variance, not risk-free arbitrage.

### ⚠️ On the surrounding content ecosystem

A widely-cited arbitrage tutorial found while checking these rates works an example at
100 contracts (gross $2.00, fees $3.15 → loss), then claims scaling to 1,000 contracts
fixes it because *"gross profit of $20 easily clears the $3.15 fee load."* Per-contract
fees scale linearly too: fees become $31.50 against $20 gross. It is a **larger** loss.
That is the quality bar of most writing in this space, including the post under review.

## 6. The mechanic the post buries: complete sets redeem immediately

This is the single most important operational fact, and the post mentions
`PositionSplit`/`PositionsMerge` only in passing as event names to query.

- **Binary market**: buy 1 YES + 1 NO for `S < $1`, call `mergePositions` on the
  Conditional Tokens Framework contract, receive exactly $1 of collateral. **Immediately.**
  No waiting for resolution.
- **Neg-risk set**: a NO share in any outcome converts to 1 YES in *every* other outcome
  plus collateral, via the
  [NegRiskAdapter](https://docs.polymarket.com/concepts/negative-risk) — the mechanic
  behind the $17.3M buy-all-NO bucket.

So the trade is **not** capital-locked until resolution. Capital rotates in one Polygon
block. That is what makes the strategy capital-efficient, and it is why this repo targets
single-venue complete sets rather than cross-venue spreads.

## 7. Why this repo does NOT do cross-venue arbitrage

Cross-venue (buy YES on Polymarket, buy NO on Kalshi for the same event) looks accessible
to a small operator because it does not require winning a latency race. It is a trap for
reasons the post never names:

- **No merge.** Different venues, different collateral, no complete set — you are locked
  until resolution and post full collateral on both sides.
- **Resolution criteria differ.** The sibling `prediction-market-mm` repo *measured* this:
  539 settled Kalshi windows compared against locally computed Chainlink ge/ge showed
  **5.01% disagreement [95% CI 3.47–7.19%]** — vastly larger than any plausible edge.
  Polymarket settles BTC on Chainlink with an exact tie resolving DOWN; Kalshi settles on
  CF Benchmarks BRTI, a 60-second average, with a tie resolving UP. Two markets on "the
  same" event settle opposite ways several percent of the time.
- **Oracle risk.** Polymarket resolves via UMA's optimistic oracle; disputes have reversed
  outcomes people considered settled.
- Fiat/USDC transfer latency between venues bounds capital rotation.

Single-venue complete-set arbitrage has **none** of these. Same venue, same oracle, same
resolution event, and an instant merge. It is strictly the better trade, and it is where
99.76% of the measured money actually was.

## 8. What is actually hard

Nothing here requires a PhD. It requires infrastructure and capital. The real problems:

1. **Fee-aware, price-aware thresholding** — not a flat 5¢. Compute
   `Σ feeRate × pᵢ × (1−pᵢ)` across every leg.
2. **Depth-aware sizing** — capacity is **share-constrained, not dollar-constrained**: an
   arb locks $1 per share-*set*, so size is `min(sharesᵢ) × Σ costᵢ`. Taking min(dollars)
   understates the cheap leg.
3. **Non-atomic leg failure** — the CLOB fills legs sequentially. A partial complete set
   is a naked directional position, which is the exact thing the trade exists to avoid.
   The unwind policy must be written before arming, and mechanical.
4. **Capital recycling** — merge/convert/redeem promptly or effective capital shrinks
   through the day and late opportunities get skipped, silently biasing capture.
5. **Competition** — measured windows are short. Every dollar captured advertises the
   opportunity.

## 9. Recommendation, and what this repo does about it

Before writing any order-placing code, point a **read-only scanner** at the venues for a
week and log how many opportunities clear a *post-fee* threshold **and** have depth. That
is a few days of work and it answers the economic question before any money is at risk.

That is exactly the sequencing in [PLAN.md](PLAN.md): items **A-1 … A-10** build the
measurement system and place no orders at all. **A-11 … A-14** add execution, inert by
default behind independent arm switches, following the arming ladder proven in the sibling
repo.

If the scanner shows the post-fee, depth-cleared opportunity density is too thin, the
project stops there, having cost a week and no capital. That is the system working.

---

## Sources

- [arXiv:2508.03474](https://arxiv.org/abs/2508.03474) — *Unravelling the Probabilistic Forest: Arbitrage in Prediction Markets*
- [arXiv:1606.02825](https://arxiv.org/abs/1606.02825) — *Arbitrage-Free Combinatorial Market Making via Integer Programming*
- [Polymarket — fees](https://docs.polymarket.com/trading/fees) · [order lifecycle](https://docs.polymarket.com/concepts/order-lifecycle) · [negative risk](https://docs.polymarket.com/concepts/negative-risk) · [trading rate limits](https://docs.polymarket.com/api-reference/trading-rate-limits)
- [Kalshi API docs](https://docs.kalshi.com/) · fee formula cross-checked in `prediction-market-mm/docs/adapters.md` against Kalshi's published schedule endpoints
- [Limitless docs](https://docs.limitless.exchange/)
- `prediction-market-mm` — `docs/adapters.md` (verified per-venue facts), `docs/live-risks.md` (12-factor live risk register), `docs/go-live-plan.md` (arming ladder)

*Feasibility analysis, not investment advice.*
