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
 * NOT YET WIRED (A-10): singleton lock, watchdog, alerting.
 */

import { loadConfig } from '../lib/config.mjs';
import { openDb, persistMarkets } from '../lib/db.mjs';
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
const db = openDb(cfg.db);
const policy = createPersistPolicy({ missSampleMs: cfg.missSampleMs });
const log = (...p) => console.log(new Date().toISOString(), ...p);

let stopping = false;
let crawls = 0;
let recorded = 0;
let cleared = 0;

async function crawlAndScan() {
  const t0 = Date.now();
  const tops = new Map();
  const rows = await discoverMarkets({
    onEvent: (event) => {
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

function shutdown(reason) {
  stopping = true;
  log(`shutting down (${reason}); crawls=${crawls} recorded=${recorded} clears=${cleared}`);
  db.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log('unhandled rejection:', err?.message ?? String(err)));
if (runSeconds > 0) setTimeout(() => shutdown(`--seconds ${runSeconds}`), runSeconds * 1000);

// Sequential, never on a timer: a crawl already takes ~54s, so overlapping runs would
// stack up requests and earn a 429 rather than fresher data.
do {
  try {
    await crawlAndScan();
  } catch (err) {
    log('crawl failed:', err.message);
    if (!once && !stopping) await new Promise((r) => setTimeout(r, 5000));
  }
} while (!once && !stopping);

if (once) shutdown('--once');
