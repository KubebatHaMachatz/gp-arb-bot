#!/usr/bin/env node
/**
 * Polymarket live scanner — the Phase 1 measurement runner.
 *
 * READ-ONLY against the venue. It loads no credentials, and there is no code path from
 * here to an order. Its whole job is to record how often a complete set clears a
 * post-fee, depth-aware threshold — the evidence the Phase 2 go/no-go decision needs.
 *
 *   node scripts/scan_polymarket.mjs [--seconds N] [--once]
 *
 * All logic lives in `lib/scanner_polymarket.mjs` and is unit-tested there; this file is
 * deliberately thin process wiring.
 *
 * NOT YET WIRED (arrives with its own item, and this script is not a 24/7 service until
 * then): the singleton lock port, the staleness watchdog, and Telegram alerting are A-10.
 * Running two copies of this concurrently would double-write `opportunities`.
 */

import { loadConfig } from '../lib/config.mjs';
import { openDb } from '../lib/db.mjs';
import { discoverMarkets, groupIntoSets } from '../lib/adapters/polymarket.mjs';
import {
  WS_URL,
  buildSubscribe,
  createBookStore,
  createPersistPolicy,
  indexSetsByToken,
  parseFrame,
  persistOpportunity,
  scanSets,
  setsForTokens,
  tokensForSets,
  tokensInMessage,
} from '../lib/scanner_polymarket.mjs';

const args = process.argv.slice(2);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const runSeconds = Number(flagValue('--seconds') ?? 0);
const once = args.includes('--once');

const cfg = loadConfig();
const db = openDb(cfg.db);

const log = (...parts) => console.log(new Date().toISOString(), ...parts);

log('discovering markets…');
const rows = await discoverMarkets();
const { sets, dropped } = groupIntoSets(rows, { withDrops: true });

const dropCounts = {};
for (const d of dropped) dropCounts[d.reason] = (dropCounts[d.reason] ?? 0) + 1;

const tokens = tokensForSets(sets);
log(
  `discovered ${rows.length} rows -> ${sets.length} complete sets ` +
    `(${tokens.length} tokens); dropped ${dropped.length}`,
  JSON.stringify(dropCounts),
);

if (once) {
  db.close();
  process.exit(0);
}
if (sets.length === 0) {
  log('no complete sets to watch; exiting');
  db.close();
  process.exit(0);
}

const store = createBookStore();
const index = indexSetsByToken(sets);
const policy = createPersistPolicy({ missSampleMs: cfg.missSampleMs });
let scanned = 0;
let evaluated = 0;
let recorded = 0;
let cleared = 0;

/**
 * Price the touched sets and record what is worth recording.
 *
 * Clears are always written; misses are sampled per event key. Misses still have to be
 * measurable — a scanner that only logs its wins cannot answer the question this phase
 * exists to answer — but recording every re-evaluation of the same verdict is not what
 * makes them measurable, it is just write amplification.
 */
function scanAndRecord(touchedSets) {
  if (touchedSets.length === 0) return;
  const t0 = Date.now();
  let batch;
  try {
    batch = scanSets({ sets: touchedSets, store, cfg, nowMs: Date.now() });
  } catch (err) {
    // An unmapped fee category throws by design. Log and keep measuring rather than
    // taking the whole scanner down.
    log('scan error:', err.message);
    return;
  }
  const detectedMs = Date.now() - t0;
  scanned += 1;
  evaluated += batch.length;

  const nowMs = Date.now();
  for (const row of batch) {
    if (!policy.shouldPersist(row, nowMs)) continue;
    try {
      persistOpportunity(db, { ...row, detectedMs });
      recorded += 1;
      if (row.clears) {
        cleared += 1;
        log(
          `CLEARS ${row.kind} ${row.eventKey} net=${row.netEdge.toFixed(4)} ` +
            `cap=$${row.capacityUsd.toFixed(2)} bound=${row.bindingLeg} age=${row.bookAgeMs}ms`,
        );
      }
    } catch (err) {
      log('persist error:', err.message);
    }
  }
}

const ws = new WebSocket(WS_URL);

ws.addEventListener('open', () => {
  log(`connected; subscribing ${tokens.length} tokens`);
  ws.send(JSON.stringify(buildSubscribe(tokens)));
});

ws.addEventListener('message', (ev) => {
  const text = typeof ev.data === 'string' ? ev.data : String(ev.data);
  const messages = parseFrame(text);
  if (messages.length === 0) return;

  // Rescan ONLY the sets this batch touched. Rescanning everything re-evaluates sets
  // whose own books have not moved, which floods the table with stale-book skips.
  const touchedTokens = new Set();
  for (const msg of messages) {
    store.applyMessage(msg);
    for (const tokenId of tokensInMessage(msg)) touchedTokens.add(tokenId);
  }
  scanAndRecord(setsForTokens(index, touchedTokens));
});

ws.addEventListener('error', (err) => log('ws error:', err?.message ?? String(err)));
ws.addEventListener('close', (ev) => log('ws closed', ev?.code ?? '', ev?.reason ?? ''));

// The venue answers PING with PONG; without it the connection is dropped.
const keepalive = setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) ws.send('PING');
}, 10_000);

const report = setInterval(() => {
  log(
    `scans=${scanned} evaluated=${evaluated} recorded=${recorded} ` +
      `clears=${cleared} tokens=${store.size}`,
  );
}, 60_000);

function shutdown(reason) {
  log(
    `shutting down (${reason}); scans=${scanned} evaluated=${evaluated} ` +
      `recorded=${recorded} clears=${cleared}`,
  );
  clearInterval(keepalive);
  clearInterval(report);
  try {
    ws.close();
  } catch {
    // already closing
  }
  db.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
if (runSeconds > 0) setTimeout(() => shutdown(`--seconds ${runSeconds}`), runSeconds * 1000);
