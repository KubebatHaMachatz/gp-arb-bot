# gp-arb-bot

**G**uaranteed-**P**rofit **arb**itrage bot for prediction markets — Polymarket, Kalshi,
Limitless.

Single-venue, complete-set arbitrage: buy every outcome of the same event for less than
$1 and redeem the complete set for exactly $1. Same venue, same resolution source, so
there is **no settlement risk** and **no capital lockup** — a complete set merges back to
collateral immediately, without waiting for the market to resolve.

This is the category that produced **99.76%** of the $39.6M of arbitrage measured on
Polymarket over Apr 2024 – Apr 2025 ([arXiv:2508.03474](https://arxiv.org/abs/2508.03474)).
See [ANALYSIS.md](ANALYSIS.md) for why, and for what changed when Polymarket introduced
taker fees in January 2026.

> **Status: pre-alpha.** Ships disarmed. The measurement phase (a read-only scanner that
> records post-fee opportunity density) comes before any order-placing code exists — see
> [PLAN.md](PLAN.md).

Sibling repo: [`prediction-market-mm`](../prediction-market-mm) — cross-venue market
making on short-horizon crypto up/down markets. Different thesis, different trade,
deliberately separate codebase.
