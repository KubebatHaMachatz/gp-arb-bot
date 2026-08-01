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
- **Zero runtime dependencies.** Node ≥22.9 builtins only (`node:sqlite`, `node:http`,
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
   scripts/watchdog.mjs  →  per-venue feed staleness + retention sweep
   (lib/watchdog.mjs, lib/notify.mjs)                   → Telegram, inert by default
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
- **One writer per venue, enforced.** Each scanner takes a `lib/singleton.mjs` port lock
  before it opens the database. Two copies would double-write `opportunities` without
  erroring anywhere, doubling the apparent opportunity rate that the Phase 2 gate is
  decided on. A bound port rather than a pidfile: the kernel reclaims it however the
  process dies, so a crash never leaves a stale lock blocking the next start.
- **Silence is the failure mode to design against.** A scanner that stays connected, keeps
  its counters climbing and records nothing looks healthy from the inside. Two guards:
  `lib/contract.mjs` catches a renamed payload field (an **absent** key is drift; a key
  present with a **null** value is ordinary data), and `scripts/watchdog.mjs` watches the
  only trustworthy signal from outside — when a row last landed in the database.

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
`OPENRANGE_`/`BREAKOUT_BOT_`). See `lib/config.mjs`.

**The rule:** an **unset** knob uses its default; a knob **set to something invalid** is a
startup crash naming the variable and quoting the value. Never a silent fallback — a bot
running on a default the operator thought they had overridden loses money without leaving
a trace. Blank/whitespace-only counts as unset (`GPA_PORT=` means "I did not set this").

| Var | Default | Range | Effect |
|---|---|---|---|
| `GPA_DB` | `data/arb.db` | non-empty | SQLite file path |
| `GPA_BOOK_STALE_MS` | `750` | 1–60000 | Freshness gate — never act on a book image older than this. Bounded **both** ways: `0` rejects every book, and a huge value is not a lenient gate but *no* gate. |
| `GPA_CLOCK_SKEW_TOLERANCE_MS` | `5000` | 0–60000 | The other side of the freshness gate — how far a venue's own timestamp may run *ahead* of this process's clock before it is treated as anomalous rather than ordinary jitter (measured live at up to ~190ms). `bookAgeMs > bookStaleMs` can never trip on a negative age, however large, so without this an NTP glitch or corrupted timestamp is silently "maximally fresh". Bounded above for the same reason `GPA_BOOK_STALE_MS` is: an unbounded tolerance reopens the same hole on the other side of zero. |
| `GPA_MIN_NET_EDGE` | `0.005` | (0, 1] | Minimum post-fee edge per complete set, as a price fraction |
| `GPA_MAX_SET_SIZE_USD` | `250` | > 0 | Hard cap on notional per complete set |
| `GPA_DEPTH_SAFETY_FACTOR` | `0.5` | (0, 1] | Size to `min(depth) × this`. **0 is rejected** — it is not "disabled", it silently sizes every trade to nothing. |
| `GPA_MISS_SAMPLE_MS` | `300000` | ≥ 0 | How often a **non-clearing** set may be re-recorded, per event key. Clears are always written. **0 records every miss** — a diagnostic setting; a live run without this bound wrote 635k rows and 346MB in 54s. |
| `GPA_REDISCOVER_MS` | `900000` | ≥ 60000 | How often the scanner rebuilds its market universe. Discovering once at startup measures a universe that only shrinks. A rotation forces a **reconnect**, never a resubscribe. |
| `GPA_KEEP_OPP_DAYS` | `90` | ≥ 0 | `opportunities` retention; **0 = disabled** |
| `GPA_DB_BUSY_TIMEOUT_MS` | `5000` | ≥ 0 | SQLite `busy_timeout`. **0 IS valid** — SQLite's defined "fail immediately on lock conflict" mode. |
| `GPA_BIND` | `127.0.0.1` | non-empty | Dashboard bind host; loopback-only unless changed |
| `GPA_PORT` | `4324` | 1024–65535 | Dashboard HTTP port |
| `GPA_LOCK_PORT_POLYMARKET` | `43241` | 1024–65535 | Singleton lock, Polymarket scanner |
| `GPA_LOCK_PORT_KALSHI` | `43242` | 1024–65535 | Singleton lock, Kalshi scanner |
| `GPA_LOCK_PORT_LIMITLESS` | `43243` | 1024–65535 | Singleton lock, Limitless scanner |
| `GPA_LOCK_PORT_WATCHDOG` | `43244` | 1024–65535 | Singleton lock, watchdog — it owns the retention sweep, so it is a writer too |
| `GPA_WATCHDOG_INTERVAL_MS` | `60000` | ≥ 1000 | How often the watchdog checks every feed's clock |
| `GPA_WATCHDOG_REPEAT_MS` | `1800000` | ≥ 0 | Before a **still-stale** feed is re-reported. **0 re-reports every check** — valid, and the fastest way to get the alert channel muted. |
| `GPA_STARTUP_PING_MIN_GAP_MS` | `60000` | ≥ 0 | Minimum gap between startup announcements. Separates a deliberate restart (announce) from a launchd `KeepAlive` crash loop (do not announce every 10s until the channel is muted). Throttled **through the database**, since in-process state dies with the process it was meant to protect. |
| `GPA_FEED_STALE_MS_POLYMARKET` | `600000` | ≥ 1 | Staleness threshold, Polymarket |
| `GPA_FEED_STALE_MS_KALSHI` | `1800000` | ≥ 1 | Staleness threshold, Kalshi |
| `GPA_FEED_STALE_MS_LIMITLESS` | `1800000` | ≥ 1 | Staleness threshold, Limitless |
| `GPA_WATCH_VENUES` | *(auto)* | csv | Venues the watchdog monitors. Unset = whatever is already in the DB, so a venue nobody runs is not alerted on. Pin it when "kalshi should be running" is itself worth monitoring. |
| `GPA_TELEGRAM_BOT_TOKEN` | *(unset)* | — | Alerting. **Read from `process.env` directly, never through `loadConfig`** — anything in the config object is one `console.log(cfg)` from a log file. |
| `GPA_TELEGRAM_CHAT_ID` | *(unset)* | — | Alerting. Inert unless **both** halves are set; half-configured says so once at startup. |

### Where secrets go

**`.env` in the repo root, mode 0600.** Copy `.env.example`. Node loads it itself via
`--env-file-if-exists`, which the installed plists pass — no dotenv dependency, no import.

`--env-file-if-exists`, not `--env-file`: the services must start on a machine with no
`.env`, which is the normal state until somebody configures alerting. `--env-file` treats
a missing file as fatal, turning "alerting not set up yet" into three crash-looping
LaunchAgents.

Running a script **by hand** does not get the flag. Either export the variables or pass it:

```bash
node --env-file-if-exists=.env scripts/watchdog.mjs
```

Two places a secret must **not** go:

- **A launchd plist.** Mode 644 in `~/Library/LaunchAgents`, readable by every account on
  the machine, and captured by Time Machine long after the value is rotated.
  `lib/launchd.mjs` refuses to render one.
- **`launchctl setenv`.** It publishes the value to *every* process in the GUI session, so
  any program you run can read it back with `launchctl getenv`.

**`GPA_FEED_STALE_MS_*` must exceed `GPA_MISS_SAMPLE_MS`, and startup enforces it.** The
coupling is invisible from either knob alone: a healthy but quiet feed writes nothing for
one whole sampling period *by design*, so a threshold at or below that period alerts on
normal operation until somebody mutes the channel.

The thresholds differ **per venue** and must stay that way. Polymarket is a WebSocket
firehose updating sub-second; Kalshi is a public REST crawl measured at 34–54s per pass.
One shared number either cries wolf on Kalshi every few minutes or is far too slack to
notice Polymarket dying.

Note the deliberate asymmetry between `GPA_DEPTH_SAFETY_FACTOR` (0 invalid) and
`GPA_DB_BUSY_TIMEOUT_MS` (0 valid). They look like the same "non-negative number" rule and
are not. Do not unify them.

All four ports are also checked **against each other** — two writers sharing a lock port
is a silent failure where the second process refuses to start and that venue is simply
never collected, with no error anywhere.

Ports claimed by this repo on this machine (registered in `~/code/bot_ports.txt`):

| What | Port |
|---|---|
| Singleton lock block | **43241–43249** (43241/2/3/4 wired, rest reserved) |
| Dashboard | **4324** |

Before claiming any new port anywhere on this machine: check `~/code/bot_ports.txt`
first, then `lsof`, then grep every sibling repo's source for the literal number. `lsof`
only proves a port is free *right now*; a source grep proves nobody else claims it.

---

## 5. Testing

```bash
npm test          # full suite (Node >= 22.9)
npm run coverage  # native line/branch coverage per lib file
npm run mutate    # Stryker mutation score → reports/mutation/mutation.html
```

## 5a. Running it

Every entry point has an npm script. Prefer them: `npm run` executes from the package
root, so they work from any directory in the repo, whereas `node scripts/…` is silently
cwd-dependent and fails with a bare "Cannot find module" from anywhere else.

```bash
npm run scan:polymarket
npm run watchdog
npm run dashboard
npm run launchd:install -- --dry-run     # note the `--`, which forwards flags
```

**The `node` written into a plist must be a durable path.** `process.execPath` resolves
symlinks, so on this machine it lands in `~/.hermes/node/bin/node` — a tool-managed
private runtime. A LaunchAgent pointing there breaks *permanently and silently* the day
that tool upgrades: launchd cannot spawn, `KeepAlive` retries every 10s forever, and the
only trace is the system log. `launchd_install` therefore prefers a system prefix
(`/opt/homebrew/bin/node`, `/usr/local/bin/node`, `/usr/bin/node`), verifies it meets
`engines`, warns loudly if it has to fall back to a hidden-directory runtime, and takes
`--node /absolute/path` to override.

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
