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
 * Two copies running at once would double-write `opportunities` — silently, since nothing
 * errors — and double the apparent opportunity rate that the Phase 2 gate is decided on.
 * The singleton lock below is what makes that impossible. Feed staleness and alerting are
 * the watchdog's job, in `scripts/watchdog.mjs`.
 */

import { loadConfig } from '../lib/config.mjs';
import { createDriftDetector } from '../lib/contract.mjs';
import { openDb, persistMarkets } from '../lib/db.mjs';
import { acquireLock } from '../lib/singleton.mjs';
import { NAME as VENUE, discoverMarkets, feeFnFor, groupIntoSets } from '../lib/adapters/polymarket.mjs';
import {
  WS_URL,
  buildSubscribe,
  createBookStore,
  createPersistPolicy,
  indexSetsByToken,
  parseFrame,
  persistOpportunity,
  scanSets,
  reconnectDelayMs,
  setsForTokens,
  tokenSetChanged,
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
const log = (...parts) => console.log(new Date().toISOString(), ...parts);

const lock = await acquireLock({
  port: cfg.lockPorts.polymarket,
  label: 'gp-arb-bot scan-polymarket',
  hint: 'GPA_LOCK_PORT_POLYMARKET',
}).catch((err) => {
  log(err.message);
  process.exit(1);
});

const db = openDb(cfg.db);

/**
 * The payload fields this scanner cannot work without.
 *
 * Every one of them fails SILENTLY if the venue renames or drops it. A missing `asks`
 * reads as an empty ladder, so the set has no ask, so it is skipped as incomplete — and
 * the scanner keeps running, connected and healthy-looking, recording nothing. A missing
 * `timestamp` is the same story via the freshness gate. That is the failure this detects;
 * a `null` VALUE in any of them is ordinary data and is not drift.
 */
const bookDrift = createDriftDetector({
  required: ['event_type', 'asset_id', 'bids', 'asks', 'timestamp'],
  label: 'polymarket book frame',
  onDrift: (r) => log('DRIFT:', r.message),
});
const priceChangeDrift = createDriftDetector({
  required: ['event_type', 'price_changes', 'timestamp'],
  label: 'polymarket price_change frame',
  onDrift: (r) => log('DRIFT:', r.message),
});

const store = createBookStore();
const policy = createPersistPolicy({ missSampleMs: cfg.missSampleMs });

let sets = [];
let index = new Map();
let tokens = [];
let scanned = 0;
let evaluated = 0;
let recorded = 0;
let cleared = 0;
let ws = null;
let attempt = 0;
let stopping = false;

/**
 * Rebuild the tradeable universe.
 *
 * Re-run periodically, not just at startup: markets are created and resolved
 * continuously, so a scanner that discovers once measures a universe that only shrinks
 * over a week-long run, and would silently miss every market created after boot.
 *
 * @returns {Promise<boolean>} whether the token set rotated
 */
async function rediscover() {
  const rows = await discoverMarkets();
  const grouped = groupIntoSets(rows, { withDrops: true });
  const dropCounts = {};
  for (const d of grouped.dropped) dropCounts[d.reason] = (dropCounts[d.reason] ?? 0) + 1;

  const nextTokens = tokensForSets(grouped.sets);
  const rotated = tokenSetChanged(tokens, nextTokens);

  sets = grouped.sets;
  index = indexSetsByToken(sets);
  tokens = nextTokens;

  // Persist the market metadata too. Without it the per-category readout collapses to
  // "(unknown)" and the fee-free bucket -- the one place taker arbitrage still works
  // cleanly -- becomes invisible exactly when it matters.
  try {
    persistMarkets(db, rows, Date.now());
  } catch (err) {
    log('market persist error:', err.message);
  }

  log(
    `discovered ${rows.length} rows -> ${sets.length} complete sets ` +
      `(${tokens.length} tokens); dropped ${grouped.dropped.length}`,
    JSON.stringify(dropCounts),
    rotated ? '[ROTATED]' : '',
  );
  return rotated;
}

log('discovering markets…');
await rediscover();

if (once) {
  db.close();
  await lock.release();
  process.exit(0);
}
if (sets.length === 0) {
  log('no complete sets to watch; exiting');
  db.close();
  await lock.release();
  process.exit(0);
}

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
    batch = scanSets({ venue: VENUE, feeFnFor, sets: touchedSets, store, cfg, nowMs: Date.now() });
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

/**
 * Open a socket and subscribe.
 *
 * Every connect starts from an EMPTY book store. While disconnected the scanner misses
 * cancellations, so a level pulled during the gap would otherwise survive and be read as
 * the best ask — a price nobody is offering, which understates cost. The venue re-sends
 * full snapshots on subscribe, so discarding costs nothing.
 */
function connect() {
  if (stopping) return;
  store.clear();
  ws = new WebSocket(WS_URL);

  ws.addEventListener('open', () => {
    attempt = 0;
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
    const driftNow = Date.now();
    for (const msg of messages) {
      if (msg?.event_type === 'book') bookDrift.check(msg, driftNow);
      else if (msg?.event_type === 'price_change') priceChangeDrift.check(msg, driftNow);

      store.applyMessage(msg);
      for (const tokenId of tokensInMessage(msg)) touchedTokens.add(tokenId);
    }
    scanAndRecord(setsForTokens(index, touchedTokens));
  });

  ws.addEventListener('error', (err) => log('ws error:', err?.message ?? String(err)));

  ws.addEventListener('close', (ev) => {
    if (stopping) return;
    // A dropped socket must never leave the process alive-but-idle: the timers below
    // would keep it looking healthy while it recorded nothing, and a week of that
    // produces a partial dataset indistinguishable from a complete one.
    const delay = reconnectDelayMs(attempt);
    attempt += 1;
    log(`ws closed (${ev?.code ?? '?'}); reconnecting in ${delay}ms (attempt ${attempt})`);
    setTimeout(connect, delay);
  });
}

connect();

// The venue answers PING with PONG; without it the connection is dropped.
const keepalive = setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN) ws.send('PING');
}, 10_000);

const report = setInterval(() => {
  log(
    `scans=${scanned} evaluated=${evaluated} recorded=${recorded} ` +
      `clears=${cleared} tokens=${store.size} connected=${ws?.readyState === WebSocket.OPEN}`,
  );
}, 60_000);

const rediscovery = setInterval(async () => {
  try {
    const rotated = await rediscover();
    // A resubscribe on an open socket is reported not to take effect, so a rotation is
    // answered by tearing the connection down. Closing triggers the reconnect path,
    // which resubscribes the new token set against a cleared store.
    if (rotated && ws?.readyState === WebSocket.OPEN) {
      log('token set rotated; forcing reconnect so the new tokens actually stream');
      ws.close();
    }
  } catch (err) {
    // Keep measuring on the existing universe rather than dying at a transient 5xx.
    log('rediscovery failed:', err.message);
  }
}, cfg.rediscoverMs);

async function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  const drift = bookDrift.stats();
  log(
    `shutting down (${reason}); scans=${scanned} evaluated=${evaluated} ` +
      `recorded=${recorded} clears=${cleared} driftedFrames=${drift.drifted}`,
  );
  clearInterval(keepalive);
  clearInterval(report);
  clearInterval(rediscovery);
  try {
    ws?.close();
  } catch {
    // already closing
  }
  db.close();
  await lock.release();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  log('unhandled rejection:', err?.message ?? String(err));
});
if (runSeconds > 0) setTimeout(() => shutdown(`--seconds ${runSeconds}`), runSeconds * 1000);
