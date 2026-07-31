#!/usr/bin/env node
/**
 * Kalshi live scanner — the Phase 1 measurement runner for this venue.
 *
 *   node scripts/scan_kalshi.mjs [--seconds N] [--once]
 *
 * READ-ONLY: no credentials, no path to an order.
 *
 * Unlike Polymarket's push feed this is a REST crawl, because Kalshi's WebSocket needs
 * authentication even to connect. A full crawl of the open universe measured ~54s live,
 * and the venue publishes no book-freshness field, so most sets will be gated out as
 * stale. That is the finding rather than a defect — see lib/scanner_kalshi.mjs.
 *
 * Two copies running at once would double-write `opportunities` without erroring, and
 * double the apparent opportunity rate the Phase 2 gate is decided on. The singleton lock
 * below prevents that. Feed staleness and alerting live in `scripts/watchdog.mjs`.
 */

import { loadConfig } from '../lib/config.mjs';
import { createDriftDetector } from '../lib/contract.mjs';
import { openDb, persistMarkets } from '../lib/db.mjs';
import { acquireLock } from '../lib/singleton.mjs';
import {
  NAME as VENUE,
  asksFromMarket,
  discoverMarkets,
  feeFnFor,
  groupIntoSets,
} from '../lib/adapters/kalshi.mjs';
import { createPollStore, topsFromEvent } from '../lib/scanner_kalshi.mjs';
import { createPersistPolicy, persistOpportunity, scanSets } from '../lib/scanner_polymarket.mjs';

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  return i === -1 ? null : args[i + 1];
};
const runSeconds = Number(flag('--seconds') ?? 0);
const once = args.includes('--once');

const cfg = loadConfig();
const log = (...p) => console.log(new Date().toISOString(), ...p);

const lock = await acquireLock({
  port: cfg.lockPorts.kalshi,
  label: 'gp-arb-bot scan-kalshi',
  hint: 'GPA_LOCK_PORT_KALSHI',
}).catch((err) => {
  log(err.message);
  process.exit(1);
});

const db = openDb(cfg.db);
const policy = createPersistPolicy({ missSampleMs: cfg.missSampleMs });

/**
 * The event fields this crawl cannot work without.
 *
 * `markets` absent yields an empty array and therefore an event with no legs, which is
 * dropped as an incomplete set -- so a rename here would zero the crawl while every log
 * line still reported a successful pass. `mutually_exclusive` absent is read as `false`,
 * which silently reclassifies every neg-risk group as unrelated binaries. Both are
 * invisible without this check; a `null` VALUE in either is ordinary data.
 */
const eventDrift = createDriftDetector({
  required: ['event_ticker', 'markets', 'mutually_exclusive'],
  label: 'kalshi event payload',
  onDrift: (r) => log('DRIFT:', r.message),
});

let stopping = false;
let crawls = 0;
let recorded = 0;
let cleared = 0;

async function crawlAndScan() {
  const t0 = Date.now();
  const tops = new Map();
  const rows = await discoverMarkets({
    onEvent: (event) => {
      eventDrift.check(event, Date.now());
      for (const [token, top] of topsFromEvent(event, asksFromMarket)) tops.set(token, top);
    },
  });
  const crawlMs = Date.now() - t0;
  crawls += 1;

  try {
    persistMarkets(db, rows, Date.now());
  } catch (err) {
    log('market persist error:', err.message);
  }

  const { sets, dropped } = groupIntoSets(rows, { withDrops: true });
  const dropCounts = {};
  for (const d of dropped) dropCounts[d.reason] = (dropCounts[d.reason] ?? 0) + 1;

  const store = createPollStore(rows, tops);
  const nowMs = Date.now();
  const batch = scanSets({ venue: VENUE, feeFnFor, sets, store, cfg, nowMs });

  let written = 0;
  let gated = 0;
  for (const row of batch) {
    if (row.skipped) gated += 1;
    if (!policy.shouldPersist(row, nowMs)) continue;
    try {
      persistOpportunity(db, { ...row, detectedMs: crawlMs });
      written += 1;
      recorded += 1;
      if (row.clears) {
        cleared += 1;
        log(
          `CLEARS ${row.kind} ${row.eventKey} net=${row.netEdge.toFixed(4)} ` +
            `cap=$${row.capacityUsd.toFixed(2)} age=${row.bookAgeMs}ms`,
        );
      }
    } catch (err) {
      log('persist error:', err.message);
    }
  }

  log(
    `crawl ${crawlMs}ms -> ${rows.length} rows, ${sets.length} sets ` +
      `(dropped ${dropped.length} ${JSON.stringify(dropCounts)}); ` +
      `priced ${batch.length - gated}, gated-stale ${gated}, wrote ${written}, clears ${cleared}`,
  );
}

async function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  log(
    `shutting down (${reason}); crawls=${crawls} recorded=${recorded} clears=${cleared} ` +
      `driftedEvents=${eventDrift.stats().drifted}`,
  );
  db.close();
  await lock.release();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log('unhandled rejection:', err?.message ?? String(err)));
if (runSeconds > 0) setTimeout(() => shutdown(`--seconds ${runSeconds}`), runSeconds * 1000);

/**
 * A floor between crawls.
 *
 * Sequential and never on a timer: a crawl already takes ~34-54s, so overlapping runs
 * would stack requests and earn a 429 rather than fresher data. The floor exists because
 * "the crawl is slow" is an observation, not a guarantee — a shrunken universe or a
 * cached response would otherwise let the loop spin, hammering the venue and the
 * database.
 */
const MIN_CRAWL_GAP_MS = 5000;

do {
  const started = Date.now();
  try {
    await crawlAndScan();
  } catch (err) {
    log('crawl failed:', err.message);
  }
  if (once || stopping) break;
  const gap = MIN_CRAWL_GAP_MS - (Date.now() - started);
  if (gap > 0) await new Promise((r) => setTimeout(r, gap));
} while (!stopping);

if (once) await shutdown('--once');
