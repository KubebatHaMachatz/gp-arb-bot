import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../lib/db.mjs';
import {
  DEFAULT_FEED_STALE_MS,
  assertThresholdsExceedSampling,
  classifyFeed,
  createKickPolicy,
  lastRowMsByVenue,
  parseVenueList,
  resolveWatchedVenues,
  shouldAnnounceStartup,
  startupMessage,
} from '../lib/watchdog.mjs';

const MIN = 60_000;
const NOW = Date.UTC(2026, 6, 31, 12, 0, 0);
const STARTED = NOW - 60 * MIN; // long past any warm-up

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gp-arb-wd-'));
  const db = openDb(join(dir, 'a.db'));
  try {
    return fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seed(db, venue, ts) {
  db.prepare(
    `INSERT INTO opportunities (venue, event_key, ts, kind, leg_count)
     VALUES (?, ?, ?, 'binary', 2)`,
  ).run(venue, `e-${venue}-${ts}`, ts);
}

// ── per-feed thresholds ─────────────────────────────────────────────────────

test('the default thresholds differ per venue, because the feeds differ in kind', () => {
  // Polymarket is a WebSocket firehose that updates sub-second; Kalshi is a public REST
  // crawl measured at 34-54s for a full pass. One shared threshold would either cry wolf
  // on Kalshi every few minutes or be far too slack to ever notice Polymarket dying.
  assert.ok(DEFAULT_FEED_STALE_MS.polymarket < DEFAULT_FEED_STALE_MS.kalshi);
  assert.equal(Object.isFrozen(DEFAULT_FEED_STALE_MS), true);
  for (const [venue, ms] of Object.entries(DEFAULT_FEED_STALE_MS)) {
    assert.ok(Number.isInteger(ms) && ms > 0, venue);
  }
});

test('every default threshold leaves room above the miss-sampling period', () => {
  // A healthy but quiet feed writes nothing for one whole sampling period by design.
  // A threshold at or below that period turns normal quiet into a nightly false alarm.
  for (const [venue, ms] of Object.entries(DEFAULT_FEED_STALE_MS)) {
    assert.ok(ms > 300_000, `${venue} must exceed the default GPA_MISS_SAMPLE_MS`);
  }
});

test('assertThresholdsExceedSampling rejects a threshold under the sampling period', () => {
  assert.throws(
    () => assertThresholdsExceedSampling({ polymarket: 60_000 }, 300_000),
    (err) => {
      assert.match(err.message, /polymarket/);
      assert.match(err.message, /GPA_MISS_SAMPLE_MS/);
      return true;
    },
  );
  // Exactly equal is still wrong: a feed that writes precisely on the period boundary
  // would be declared stale on the tick before its next legitimate write.
  assert.throws(() => assertThresholdsExceedSampling({ kalshi: 300_000 }, 300_000));
  assert.doesNotThrow(() => assertThresholdsExceedSampling({ kalshi: 300_001 }, 300_000));
});

test('sampling disabled with 0 imposes no floor — every miss is recorded then', () => {
  assert.doesNotThrow(() => assertThresholdsExceedSampling({ polymarket: 1 }, 0));
});

// ── classifyFeed ────────────────────────────────────────────────────────────

test('a feed that wrote inside its threshold is ok', () => {
  const f = classifyFeed({ venue: 'polymarket', lastRowMs: NOW - MIN, nowMs: NOW, thresholdMs: 10 * MIN, startedMs: STARTED });
  assert.equal(f.state, 'ok');
  assert.equal(f.ageMs, MIN);
  assert.equal(f.venue, 'polymarket');
});

test('a feed silent past its threshold is stale', () => {
  const f = classifyFeed({ venue: 'polymarket', lastRowMs: NOW - 11 * MIN, nowMs: NOW, thresholdMs: 10 * MIN, startedMs: STARTED });
  assert.equal(f.state, 'stale');
  assert.equal(f.ageMs, 11 * MIN);
});

test('the threshold boundary is inclusive — exactly at the limit is still ok', () => {
  const at = classifyFeed({ venue: 'k', lastRowMs: NOW - 10 * MIN, nowMs: NOW, thresholdMs: 10 * MIN, startedMs: STARTED });
  assert.equal(at.state, 'ok');
  const past = classifyFeed({ venue: 'k', lastRowMs: NOW - 10 * MIN - 1, nowMs: NOW, thresholdMs: 10 * MIN, startedMs: STARTED });
  assert.equal(past.state, 'stale');
});

test('a feed that has never written anything is "starting" during the warm-up', () => {
  // A fresh database is the normal state on a first run. Alerting on it would train the
  // operator to ignore the very first alert the system ever sends.
  const f = classifyFeed({ venue: 'polymarket', lastRowMs: null, nowMs: NOW, thresholdMs: 10 * MIN, startedMs: NOW - MIN });
  assert.equal(f.state, 'starting');
  assert.equal(f.ageMs, null);
  assert.equal(f.everWrote, false);
});

test('a feed that has never written is stale once the warm-up has elapsed', () => {
  const f = classifyFeed({ venue: 'polymarket', lastRowMs: null, nowMs: NOW, thresholdMs: 10 * MIN, startedMs: NOW - 11 * MIN });
  assert.equal(f.state, 'stale');
  assert.equal(f.everWrote, false);
});

test('the warm-up also covers a restart onto a database of old rows', () => {
  // Rows from last week plus a scanner that started ten seconds ago is not an incident.
  // Without the grace period every restart would page whoever is on the other end.
  const f = classifyFeed({ venue: 'kalshi', lastRowMs: NOW - 5000 * MIN, nowMs: NOW, thresholdMs: 30 * MIN, startedMs: NOW - MIN });
  assert.equal(f.state, 'starting');
  assert.equal(f.everWrote, true, 'but the age is still reported honestly');
  assert.equal(f.ageMs, 5000 * MIN);
});

test('classifyFeed validates its inputs rather than producing a nonsense state', () => {
  const base = { venue: 'p', lastRowMs: NOW, nowMs: NOW, thresholdMs: MIN, startedMs: STARTED };
  assert.throws(() => classifyFeed({ ...base, thresholdMs: 0 }), TypeError);
  assert.throws(() => classifyFeed({ ...base, thresholdMs: -1 }), TypeError);
  assert.throws(() => classifyFeed({ ...base, nowMs: Number.NaN }), TypeError);
  assert.throws(() => classifyFeed({ ...base, venue: '' }), TypeError);
  assert.throws(() => classifyFeed({ ...base, lastRowMs: 'recently' }), TypeError);
  assert.throws(() => classifyFeed({ ...base, startedMs: Number.NaN }), TypeError);
  assert.throws(() => classifyFeed({ ...base, startedMs: undefined }), TypeError);
  assert.throws(() => classifyFeed({ ...base, thresholdMs: Number.POSITIVE_INFINITY }), TypeError);
});

// ── the kick policy: alert on transitions, not on every tick ────────────────

const stale = (venue = 'polymarket') => ({ venue, state: 'stale', ageMs: 99 * MIN });
const okay = (venue = 'polymarket') => ({ venue, state: 'ok', ageMs: 1000 });

test('going stale kicks once', () => {
  const p = createKickPolicy({ repeatMs: 30 * MIN });
  const k = p.next(stale(), NOW);
  assert.equal(k.kind, 'stale');
  assert.equal(k.venue, 'polymarket');
  assert.match(k.message, /polymarket/);
});

test('staying stale does not kick again on every check', () => {
  // The watchdog ticks once a minute. Without de-duplication a feed down overnight sends
  // 480 identical messages, and the channel gets muted before the next real incident.
  const p = createKickPolicy({ repeatMs: 30 * MIN });
  p.next(stale(), NOW);
  for (let i = 1; i <= 29; i += 1) assert.equal(p.next(stale(), NOW + i * MIN), null, `minute ${i}`);
});

test('a feed still down after the repeat interval kicks again as a reminder', () => {
  const p = createKickPolicy({ repeatMs: 30 * MIN });
  p.next(stale(), NOW);
  assert.equal(p.next(stale(), NOW + 30 * MIN - 1), null);
  const again = p.next(stale(), NOW + 30 * MIN);
  assert.equal(again.kind, 'stale');
});

test('recovery kicks exactly once', () => {
  // "It came back" is the message that closes an incident. Sending it on every healthy
  // tick afterwards would be worse than not sending it at all.
  const p = createKickPolicy({ repeatMs: 30 * MIN });
  p.next(stale(), NOW);
  const rec = p.next(okay(), NOW + MIN);
  assert.equal(rec.kind, 'recovered');
  assert.match(rec.message, /recovered/i);
  assert.equal(p.next(okay(), NOW + 2 * MIN), null);
});

test('a healthy feed that was never stale says nothing at all', () => {
  const p = createKickPolicy({ repeatMs: 30 * MIN });
  for (let i = 0; i < 10; i += 1) assert.equal(p.next(okay(), NOW + i * MIN), null);
});

test('a feed that recovers and fails again kicks immediately, not after the old timer', () => {
  // Flapping is a real signal. Suppressing the second failure because the first one was
  // recent would hide exactly the pattern worth seeing.
  const p = createKickPolicy({ repeatMs: 30 * MIN });
  p.next(stale(), NOW);
  p.next(okay(), NOW + MIN);
  const second = p.next(stale(), NOW + 2 * MIN);
  assert.equal(second.kind, 'stale');
});

test('"starting" is not an opinion — it neither kicks nor clears a standing alert', () => {
  const p = createKickPolicy({ repeatMs: 30 * MIN });
  p.next(stale(), NOW);
  assert.equal(p.next({ venue: 'polymarket', state: 'starting', ageMs: null }, NOW + MIN), null);
  // The feed is still considered down, so recovery must still be reportable afterwards.
  assert.equal(p.next(okay(), NOW + 2 * MIN).kind, 'recovered');
});

test('venues are tracked independently', () => {
  const p = createKickPolicy({ repeatMs: 30 * MIN });
  assert.equal(p.next(stale('polymarket'), NOW).kind, 'stale');
  assert.equal(p.next(stale('kalshi'), NOW).kind, 'stale', 'kalshi has its own history');
  assert.equal(p.next(stale('polymarket'), NOW + MIN), null);
});

test('the kick message carries the age in a human unit', () => {
  const p = createKickPolicy({ repeatMs: 30 * MIN });
  const k = p.next({ venue: 'kalshi', state: 'stale', ageMs: 95 * MIN }, NOW);
  assert.match(k.message, /95/);
});

test('createKickPolicy validates repeatMs', () => {
  for (const bad of [undefined, -1, Number.NaN, 'soon']) {
    assert.throws(() => createKickPolicy({ repeatMs: bad }), TypeError, String(bad));
  }
});

// ── reading the feed clock out of the database ──────────────────────────────

test('lastRowMsByVenue reports the newest row per venue', () => {
  withDb((db) => {
    seed(db, 'polymarket', NOW - 5 * MIN);
    seed(db, 'polymarket', NOW - MIN);
    seed(db, 'kalshi', NOW - 20 * MIN);
    assert.deepEqual(
      lastRowMsByVenue(db),
      Object.assign(Object.create(null), { polymarket: NOW - MIN, kalshi: NOW - 20 * MIN }),
    );
  });
});

test('lastRowMsByVenue returns an empty map on an untouched database', () => {
  withDb((db) => assert.deepEqual(lastRowMsByVenue(db), Object.create(null)));
});

test('a venue with no rows is absent from the map, not zero', () => {
  // Zero would be read downstream as "wrote at the epoch", i.e. maximally stale, which is
  // a different claim from "has never written" and calls for a different response.
  withDb((db) => {
    seed(db, 'polymarket', NOW);
    const map = lastRowMsByVenue(db);
    assert.equal(Object.hasOwn(map, 'kalshi'), false);
    assert.equal(map.kalshi ?? null, null);
  });
});

test('lastRowMsByVenue returns a null-prototype map, so a venue named "constructor" is safe', () => {
  withDb((db) => {
    seed(db, 'constructor', NOW);
    const map = lastRowMsByVenue(db);
    assert.equal(map.constructor, NOW, 'a plain object would return the Object constructor here');
  });
});

// ── which venues to watch ───────────────────────────────────────────────────

const THRESHOLDS = { polymarket: 600_000, kalshi: 1_800_000, limitless: 1_800_000 };

test('parseVenueList splits, trims and drops empties', () => {
  assert.deepEqual(parseVenueList('polymarket, kalshi'), ['polymarket', 'kalshi']);
  assert.deepEqual(parseVenueList(' kalshi '), ['kalshi']);
  assert.deepEqual(parseVenueList('a,,b,'), ['a', 'b']);
});

test('parseVenueList treats unset and blank as "not configured", not as "watch nothing"', () => {
  // The difference matters: null falls through to auto-discovery, whereas an empty array
  // would be a silent instruction to monitor nothing at all.
  assert.equal(parseVenueList(undefined), null);
  assert.equal(parseVenueList(null), null);
  assert.equal(parseVenueList(''), null);
  assert.equal(parseVenueList('  ,  '), null);
});

test('with nothing configured, the watched set is whatever the database already holds', () => {
  assert.deepEqual(
    resolveWatchedVenues({ configured: null, present: ['polymarket', 'kalshi'], thresholds: THRESHOLDS }),
    ['polymarket', 'kalshi'],
  );
});

test('a venue nobody runs is not watched by default', () => {
  // Limitless has a threshold and no scanner. A monitor that alerts about it every 30
  // minutes is a monitor that gets muted, taking the real alerts with it.
  assert.deepEqual(
    resolveWatchedVenues({ configured: null, present: ['polymarket'], thresholds: THRESHOLDS }),
    ['polymarket'],
  );
});

test('an explicit list wins over auto-discovery, so a dead-from-boot scanner is still caught', () => {
  assert.deepEqual(
    resolveWatchedVenues({ configured: ['kalshi'], present: [], thresholds: THRESHOLDS }),
    ['kalshi'],
  );
});

test('a configured venue with no threshold is a startup error, never a silent skip', () => {
  assert.throws(
    () => resolveWatchedVenues({ configured: ['polymarket', 'bogus'], present: [], thresholds: THRESHOLDS }),
    (err) => {
      assert.match(err.message, /bogus/);
      assert.match(err.message, /polymarket, kalshi, limitless/);
      return true;
    },
  );
});

test('duplicates collapse, so a venue is never checked twice per tick', () => {
  assert.deepEqual(
    resolveWatchedVenues({ configured: ['kalshi', 'kalshi'], present: [], thresholds: THRESHOLDS }),
    ['kalshi'],
  );
});

test('an empty database watches nothing rather than everything', () => {
  assert.deepEqual(resolveWatchedVenues({ configured: null, present: [], thresholds: THRESHOLDS }), []);
});

// ── startup announcement: heard on a real restart, silent in a crash loop ───

test('a first-ever start is always announced', () => {
  assert.equal(shouldAnnounceStartup({ lastMs: null, nowMs: NOW, minGapMs: 60_000 }), true);
  assert.equal(shouldAnnounceStartup({ lastMs: undefined, nowMs: NOW, minGapMs: 60_000 }), true);
});

test('a deliberate restart well after the last one is announced', () => {
  assert.equal(shouldAnnounceStartup({ lastMs: NOW - 10 * MIN, nowMs: NOW, minGapMs: 60_000 }), true);
});

test('a crash loop is NOT announced on every respawn', () => {
  // launchd KeepAlive restarts a crashing service every ThrottleInterval (10s here).
  // Unguarded, that is ~360 messages an hour until somebody mutes the channel — and
  // muting is permanent in practice, taking the real staleness alerts with it.
  let sent = 0;
  let last = null;
  for (let t = 0; t < 3_600_000; t += 10_000) {
    if (shouldAnnounceStartup({ lastMs: last, nowMs: NOW + t, minGapMs: 60_000 })) {
      sent += 1;
      last = NOW + t;
    }
  }
  assert.equal(sent, 60, 'one per minute, not one per respawn');
});

test('the boundary is inclusive — exactly at the gap announces', () => {
  assert.equal(shouldAnnounceStartup({ lastMs: NOW - 60_000, nowMs: NOW, minGapMs: 60_000 }), true);
  assert.equal(shouldAnnounceStartup({ lastMs: NOW - 59_999, nowMs: NOW, minGapMs: 60_000 }), false);
});

test('a gap of 0 announces every start — valid, and rarely what anyone wants', () => {
  assert.equal(shouldAnnounceStartup({ lastMs: NOW, nowMs: NOW, minGapMs: 0 }), true);
});

test('a backwards clock announces rather than going silent', () => {
  // An NTP correction or a restored backup can put `now` behind the stored timestamp.
  // Suppressing until wall-clock caught up could silence startups for hours.
  assert.equal(shouldAnnounceStartup({ lastMs: NOW + 10 * MIN, nowMs: NOW, minGapMs: 60_000 }), true);
});

test('shouldAnnounceStartup validates its inputs', () => {
  assert.throws(() => shouldAnnounceStartup({ lastMs: null, nowMs: Number.NaN, minGapMs: 1 }), TypeError);
  assert.throws(() => shouldAnnounceStartup({ lastMs: null, nowMs: NOW, minGapMs: -1 }), TypeError);
  assert.throws(() => shouldAnnounceStartup({ lastMs: 'soon', nowMs: NOW, minGapMs: 1 }), TypeError);
});

// ── the announcement text ───────────────────────────────────────────────────

test('the startup message reports each watched feed, not just "I am alive"', () => {
  const msg = startupMessage({
    venues: ['polymarket'],
    feeds: [{ venue: 'polymarket', state: 'ok', ageMs: 2 * MIN }],
    keepOppDays: 90,
    nowMs: NOW,
  });
  assert.match(msg, /STARTED/);
  assert.match(msg, /polymarket: ok, last row 2 min ago/);
  assert.match(msg, /retention: 90 days/);
});

test('a venue with no rows yet is reported honestly, not as healthy', () => {
  const msg = startupMessage({
    venues: ['polymarket'],
    feeds: [{ venue: 'polymarket', state: 'starting', ageMs: null }],
    keepOppDays: 90,
    nowMs: NOW,
  });
  assert.match(msg, /polymarket: no rows yet \(starting\)/);
});

test('a watched venue with no classification at all says so', () => {
  const msg = startupMessage({ venues: ['kalshi'], feeds: [], keepOppDays: 90, nowMs: NOW });
  assert.match(msg, /kalshi: no data yet/);
});

test('watching nothing is stated plainly — a silent list reads as healthy', () => {
  const msg = startupMessage({ venues: [], feeds: [], keepOppDays: 90, nowMs: NOW });
  assert.match(msg, /no venues being watched/);
});

test('disabled retention is spelled out rather than shown as "0 days"', () => {
  const msg = startupMessage({ venues: [], feeds: [], keepOppDays: 0, nowMs: NOW });
  assert.match(msg, /retention: disabled/);
});

test('the startup message never contains a credential-shaped value', () => {
  const msg = startupMessage({
    venues: ['polymarket'],
    feeds: [{ venue: 'polymarket', state: 'ok', ageMs: 1000 }],
    keepOppDays: 90,
    nowMs: NOW,
  });
  assert.doesNotMatch(msg, /token|chat_id|GPA_TELEGRAM/i);
});

test('a database read failure is announced as blindness, not as "watching nothing"', () => {
  // A watchdog that comes up unable to read is the case an operator most needs to hear
  // about. Rendering it identically to a quiet, healthy start would hide it completely.
  const msg = startupMessage({ venues: [], feeds: [], keepOppDays: 90, nowMs: NOW, readFailed: true });
  assert.match(msg, /COULD NOT READ THE DATABASE/);
  assert.doesNotMatch(msg, /no venues being watched/);
});

test('readFailed defaults to false, so a normal start reads normally', () => {
  const msg = startupMessage({ venues: [], feeds: [], keepOppDays: 90, nowMs: NOW });
  assert.match(msg, /no venues being watched/);
  assert.doesNotMatch(msg, /COULD NOT READ/);
});
