-- gp-arb-bot — venue-tagged persistence for complete-set arbitrage measurement.
--
-- Pure DDL, CREATE ... IF NOT EXISTS throughout, so applying it to an existing database
-- is a no-op. NOTE: `IF NOT EXISTS` cannot MIGRATE a live file — changing a column here
-- means deleting the DB and re-collecting, so think before editing an existing table.
--
-- Every row is venue-tagged. One database, not one per venue, so a single query can
-- compare across venues without attaching multiple files.

-- ── markets ────────────────────────────────────────────────────────────────────
-- One row per outcome token.
--
-- `event_key` is the load-bearing column: it groups the tokens that form ONE
-- mutually-exclusive set. Complete-set arbitrage is undefined without that grouping —
-- it is the difference between "these prices sum to 0.94" being an arbitrage and being
-- a meaningless sum over unrelated markets. For a binary market it groups the YES and
-- NO of one condition; for a neg-risk market it groups every outcome of one event.
CREATE TABLE IF NOT EXISTS markets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  venue           TEXT    NOT NULL,
  event_key       TEXT    NOT NULL,
  condition_id    TEXT    NOT NULL,
  token_id        TEXT    NOT NULL,
  outcome         TEXT    NOT NULL,
  market_slug     TEXT,
  category        TEXT,                       -- drives the fee rate on Polymarket
  fee_rate        REAL,                       -- NULL until the venue's economics are verified
  tick_size       REAL,
  min_order_size  REAL,                       -- units are venue-specific; see docs/adapters.md
  neg_risk        INTEGER NOT NULL DEFAULT 0, -- 1 = member of a neg-risk (multi-outcome) set
  first_seen      INTEGER NOT NULL,
  last_seen       INTEGER NOT NULL,
  UNIQUE (venue, token_id)
);

CREATE INDEX IF NOT EXISTS idx_markets_event ON markets (venue, event_key);
CREATE INDEX IF NOT EXISTS idx_markets_last_seen ON markets (last_seen);

-- ── book_tops ──────────────────────────────────────────────────────────────────
-- Top-of-book per token over time. Sizes are share counts, not dollars — capacity for
-- this strategy is share-constrained (an arb locks $1 per share-SET), so storing
-- dollars here would lose the quantity the sizing math actually needs.
CREATE TABLE IF NOT EXISTS book_tops (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  venue      TEXT    NOT NULL,
  token_id   TEXT    NOT NULL,
  ts         INTEGER NOT NULL,
  best_bid   REAL,
  best_ask   REAL,
  bid_size   REAL,
  ask_size   REAL
);

CREATE INDEX IF NOT EXISTS idx_book_tops_token ON book_tops (venue, token_id, ts);
CREATE INDEX IF NOT EXISTS idx_book_tops_ts ON book_tops (ts);

-- ── opportunities ──────────────────────────────────────────────────────────────
-- One row per detected complete-set arbitrage.
--
-- `net_edge` is stored POST-fee. `gross_cost` and `total_fee` are kept alongside it so
-- a later fee-schedule correction can be re-applied to historical rows instead of
-- invalidating them — venues tune their fees, and this repo has to survive that.
CREATE TABLE IF NOT EXISTS opportunities (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  venue           TEXT    NOT NULL,
  event_key       TEXT    NOT NULL,
  ts              INTEGER NOT NULL,
  kind            TEXT    NOT NULL,  -- 'binary' | 'neg_risk'
  leg_count       INTEGER NOT NULL,
  -- NULLABLE on purpose. A set gated out by the freshness check makes NO edge claim, so
  -- these stay NULL while `skip_reason` says why. Declaring them NOT NULL would make the
  -- skipped row unstorable, and skipped rows are precisely what makes the gate's own
  -- cost measurable -- silently dropping them would flatter every capture-rate figure.
  gross_cost      REAL,              -- sum of leg prices, before fees
  total_fee       REAL,              -- sum of per-leg taker fees
  net_edge        REAL,              -- 1 - gross_cost - total_fee
  capacity_shares REAL,              -- min(shares) across legs, x the safety factor
  capacity_usd    REAL,              -- capacity_shares x (gross_cost + total_fee)
  -- WHICH constraint bound the size: a leg index (as text) or the literal 'notional'.
  -- Kept because the two call for opposite responses -- a thin book means wait, a bound
  -- notional cap means add capital -- and the capacity number alone cannot distinguish
  -- them. TEXT so a leg index and 'notional' share one column honestly.
  binding_leg     TEXT,
  book_age_ms     INTEGER,           -- oldest leg's book age at detection
  detected_ms     INTEGER,           -- wall-clock cost of the detection pass
  skip_reason     TEXT               -- NULL when acted on; e.g. 'stale_book' when gated
);

CREATE INDEX IF NOT EXISTS idx_opp_event ON opportunities (venue, event_key, ts);
CREATE INDEX IF NOT EXISTS idx_opp_venue_ts ON opportunities (venue, ts);
CREATE INDEX IF NOT EXISTS idx_opp_ts ON opportunities (ts);

-- ── opportunity_legs ───────────────────────────────────────────────────────────
-- The per-leg detail behind one opportunity. ON DELETE CASCADE so a retention sweep
-- over `opportunities` cannot leave orphaned legs behind.
CREATE TABLE IF NOT EXISTS opportunity_legs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_id INTEGER NOT NULL REFERENCES opportunities (id) ON DELETE CASCADE,
  token_id       TEXT    NOT NULL,
  outcome        TEXT    NOT NULL,
  price          REAL    NOT NULL,
  size_shares    REAL,
  fee_usd        REAL
);

CREATE INDEX IF NOT EXISTS idx_opp_legs_opp ON opportunity_legs (opportunity_id);

-- ── service_state ──────────────────────────────────────────────────────────────
-- Small key/value scratchpad for facts a service must remember ACROSS restarts.
--
-- In-memory state is useless for anything that has to survive a crash, and under launchd
-- `KeepAlive` a crashing service restarts every ThrottleInterval — so "have I already done
-- this?" has to outlive the process that asked. First use: the startup notification's
-- throttle, which is what stops a crash loop from turning into a Telegram flood.
CREATE TABLE IF NOT EXISTS service_state (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_ms INTEGER NOT NULL
);
