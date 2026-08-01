#!/usr/bin/env node
/**
 * Feed watchdog and retention sweeper.
 *
 *   node scripts/watchdog.mjs [--seconds N] [--once]
 *
 * Answers the one question a scanner cannot answer about itself: **is it still working?**
 * A process that stays connected, keeps its counters climbing and writes nothing looks,
 * from the inside, exactly like a market that has gone quiet. So this checks the only
 * trustworthy signal — when a row last landed in the database — from outside.
 *
 * It also owns the retention sweep. That belongs to exactly one process: running it in
 * every scanner would have N processes deleting concurrently from the same table, and the
 * watchdog is already the periodic single-owner job.
 *
 * The Telegram credentials are read straight from `process.env` and are deliberately NOT
 * routed through `loadConfig`. Anything in the config object is one `console.log(cfg)`
 * away from a log file; the token never enters that object at all.
 *
 * All logic lives in `lib/watchdog.mjs` and is unit-tested there; this file is process
 * wiring. Who watches the watchdog: launchd, via `KeepAlive`.
 */

import { loadConfig } from '../lib/config.mjs';
import { getState, openDb, setState, sweepOpportunities } from '../lib/db.mjs';
import { createNotifier } from '../lib/notify.mjs';
import { acquireLock } from '../lib/singleton.mjs';
import {
  STARTUP_STATE_KEY,
  classifyFeed,
  createKickPolicy,
  lastRowMsByVenue,
  parseVenueList,
  resolveWatchedVenues,
  shouldAnnounceStartup,
  startupMessage,
} from '../lib/watchdog.mjs';

const args = process.argv.slice(2);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const runSeconds = Number(flagValue('--seconds') ?? 0);
const once = args.includes('--once');

const cfg = loadConfig();
const log = (...parts) => console.log(new Date().toISOString(), ...parts);

// The watchdog writes (it sweeps), so it takes a lock like any other writer. Two sweepers
// would not corrupt anything, but two alerters would double every message.
const lock = await acquireLock({
  port: cfg.lockPorts.watchdog,
  label: 'gp-arb-bot watchdog',
  hint: 'GPA_LOCK_PORT_WATCHDOG',
}).catch((err) => {
  log(err.message);
  process.exit(1);
});

const db = openDb(cfg.db, { busyTimeoutMs: cfg.dbBusyTimeoutMs });

const notifier = createNotifier({
  botToken: process.env.GPA_TELEGRAM_BOT_TOKEN,
  chatId: process.env.GPA_TELEGRAM_CHAT_ID,
  log,
  // Overridable ONLY so an end-to-end test can point at a local stub instead of posting
  // to a real chat. Unset in every real run, which is the documented Telegram endpoint.
  ...(process.env.GPA_TELEGRAM_API_BASE ? { apiBase: process.env.GPA_TELEGRAM_API_BASE } : {}),
});
if (!notifier.enabled) {
  log('alerting is inert (GPA_TELEGRAM_BOT_TOKEN + GPA_TELEGRAM_CHAT_ID unset); logging only');
}

const configuredVenues = parseVenueList(process.env.GPA_WATCH_VENUES);
const policy = createKickPolicy({ repeatMs: cfg.watchdogRepeatMs });
const startedMs = Date.now();
let lastSweepMs = 0;
let stopping = false;

const SWEEP_EVERY_MS = 3_600_000;

/** One pass: classify every watched feed, alert on transitions, sweep if it is time. */
async function tick() {
  const nowMs = Date.now();

  let lastRow;
  try {
    lastRow = lastRowMsByVenue(db);
  } catch (err) {
    // A locked or briefly unreadable database is not an incident worth paging about, and
    // taking the watchdog down over one would remove the monitoring entirely.
    log('watchdog read failed:', err.message);
    // Reported as a READ FAILURE rather than as no data. The caller uses this to still
    // announce startup: a watchdog that comes up unable to read the database is the case
    // an operator most needs to hear about, and returning nothing would make it silent.
    return { venues: [], feeds: [], readFailed: true };
  }

  let venues;
  try {
    venues = resolveWatchedVenues({
      configured: configuredVenues,
      present: Object.keys(lastRow),
      thresholds: cfg.feedStaleMs,
    });
  } catch (err) {
    log('watchdog misconfigured:', err.message);
    process.exit(1);
  }

  const classified = [];
  for (const venue of venues) {
    const feed = classifyFeed({
      venue,
      lastRowMs: Object.hasOwn(lastRow, venue) ? lastRow[venue] : null,
      nowMs,
      thresholdMs: cfg.feedStaleMs[venue],
      startedMs,
    });

    classified.push(feed);

    const kick = policy.next(feed, nowMs);
    if (kick === null) continue;
    log(kick.message);
    await notifier.send(`[gp-arb-bot] ${kick.message}`);
  }

  if (nowMs - lastSweepMs >= SWEEP_EVERY_MS) {
    lastSweepMs = nowMs;
    try {
      const { deleted, cutoffMs } = sweepOpportunities(db, { nowMs, keepDays: cfg.keepOppDays });
      if (deleted > 0) {
        log(`retention sweep removed ${deleted} rows older than ${new Date(cutoffMs).toISOString()}`);
      }
    } catch (err) {
      log('retention sweep failed:', err.message);
    }
  }

  return { venues, feeds: classified, readFailed: false };
}

log(
  `watchdog up; interval=${cfg.watchdogIntervalMs}ms repeat=${cfg.watchdogRepeatMs}ms ` +
    `retention=${cfg.keepOppDays}d thresholds=${JSON.stringify(cfg.feedStaleMs)}`,
);

const first = await tick();

/**
 * Announce that the service is up.
 *
 * Sent AFTER the first tick so it can report real feed state instead of a bare "alive" —
 * an operator reading this on a phone should be able to tell whether the restart landed
 * somewhere healthy without opening a laptop.
 *
 * Throttled through the database rather than memory: launchd `KeepAlive` restarts a
 * crashing service every ThrottleInterval, and in-process state dies with the process it
 * was meant to protect. Without this, a crash loop posts hundreds of messages an hour
 * until the channel is muted — and a muted channel takes the staleness alerts with it.
 */
if (notifier.enabled && first) {
  const nowMs = Date.now();
  let lastMs = null;
  try {
    lastMs = getState(db, STARTUP_STATE_KEY)?.updatedMs ?? null;
  } catch (err) {
    log('could not read startup state:', err.message);
  }

  if (shouldAnnounceStartup({ lastMs, nowMs, minGapMs: cfg.startupPingMinGapMs })) {
    const message = startupMessage({ ...first, keepOppDays: cfg.keepOppDays, nowMs });
    log(message.split('\n')[0]);
    const sent = await notifier.send(`[gp-arb-bot] ${message}`);
    // Record only on a CONFIRMED send. Recording an attempt would let one network blip
    // suppress the next announcement too, which is the wrong way for this to fail.
    if (sent) {
      try {
        setState(db, STARTUP_STATE_KEY, String(nowMs), nowMs);
      } catch (err) {
        log('could not record startup state:', err.message);
      }
    }
  } else {
    log('startup notice suppressed (a recent start was already announced)');
  }
}

if (once) {
  db.close();
  await lock.release();
  process.exit(0);
}

const timer = setInterval(() => {
  tick().catch((err) => log('watchdog tick failed:', err?.message ?? String(err)));
}, cfg.watchdogIntervalMs);

async function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  log(`shutting down (${reason})`);
  clearInterval(timer);
  db.close();
  await lock.release();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log('unhandled rejection:', err?.message ?? String(err)));
if (runSeconds > 0) setTimeout(() => shutdown(`--seconds ${runSeconds}`), runSeconds * 1000);
