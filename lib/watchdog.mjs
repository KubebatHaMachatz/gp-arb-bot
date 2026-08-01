/**
 * Feed staleness monitoring.
 *
 * The scanner's own logs cannot answer "is this still working?". A process that stays
 * connected, keeps its counters climbing and writes nothing looks identical, from the
 * inside, to a market that has simply gone quiet. The only trustworthy signal is external
 * and boring: **when did a row last land in the database?**
 *
 * Two design rules follow from having run this against both venues.
 *
 * **Thresholds are per feed, never global.** Polymarket is a WebSocket firehose updating
 * sub-second; Kalshi is a public REST crawl measured at 34-54 seconds for one full pass.
 * A single shared number is either tight enough to cry wolf on Kalshi every few minutes,
 * or slack enough that Polymarket could be dead for an hour before anyone hears about it.
 *
 * **Alerts fire on transitions, not on ticks.** The watchdog checks once a minute; a feed
 * down overnight would otherwise send hundreds of identical messages, and a channel that
 * cries wolf gets muted long before the next real incident.
 *
 * Who watches the watchdog: launchd, via `KeepAlive`. See `lib/launchd.mjs`.
 */

/**
 * Per-venue staleness thresholds, in ms.
 *
 * Both sit comfortably above the default `GPA_MISS_SAMPLE_MS` (300000). That relationship
 * is not a coincidence and is enforced by `assertThresholdsExceedSampling`: a healthy but
 * quiet feed writes nothing for one whole sampling period *by design*, so a threshold at
 * or below that period converts normal quiet into a nightly false alarm.
 */
export const DEFAULT_FEED_STALE_MS = Object.freeze({
  polymarket: 600_000, // 10 min — a live WS feed across ~3,600 sets is never this quiet
  kalshi: 1_800_000, // 30 min — a full REST pass is ~34-54s, and 99.8% of sets gate stale
  limitless: 1_800_000,
});

/**
 * Reject any threshold that cannot distinguish a dead feed from a quiet one.
 *
 * @param {Record<string, number>} thresholds
 * @param {number} missSampleMs the configured miss-sampling period
 * @throws {Error} naming the venue and both knobs
 */
export function assertThresholdsExceedSampling(thresholds, missSampleMs) {
  // 0 disables sampling entirely — every miss is recorded, so no quiet period exists and
  // no floor applies.
  if (missSampleMs === 0) return;
  for (const [venue, ms] of Object.entries(thresholds)) {
    if (ms <= missSampleMs) {
      throw new Error(
        `feed staleness threshold for ${venue} (${ms}ms) must be GREATER than ` +
          `GPA_MISS_SAMPLE_MS (${missSampleMs}ms). A healthy but quiet feed legitimately ` +
          'writes nothing for one sampling period, so this would alert on normal operation.',
      );
    }
  }
}

/**
 * Classify one feed's health.
 *
 * `starting` is a real third state, not a variant of `ok`. A fresh database on a first
 * run, and a restart onto a database of week-old rows, both look exactly like a dead feed
 * for the first few minutes — and alerting on either would train the operator to ignore
 * the first alert the system ever sends. During the warm-up the age is still reported
 * honestly; only the verdict is withheld.
 *
 * @param {{venue: string, lastRowMs: number|null, nowMs: number, thresholdMs: number,
 *          startedMs: number}} args
 * @returns {{venue: string, state: 'ok'|'stale'|'starting', ageMs: number|null,
 *            everWrote: boolean, thresholdMs: number}}
 */
export function classifyFeed({ venue, lastRowMs, nowMs, thresholdMs, startedMs }) {
  if (typeof venue !== 'string' || venue.trim() === '') {
    throw new TypeError(`venue must be a non-empty string, got ${String(venue)}`);
  }
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new TypeError(`nowMs must be a finite number, got ${String(nowMs)}`);
  }
  if (typeof startedMs !== 'number' || !Number.isFinite(startedMs)) {
    throw new TypeError(`startedMs must be a finite number, got ${String(startedMs)}`);
  }
  if (typeof thresholdMs !== 'number' || !Number.isFinite(thresholdMs) || thresholdMs <= 0) {
    throw new TypeError(`thresholdMs must be a finite number > 0, got ${String(thresholdMs)}`);
  }
  if (lastRowMs !== null && (typeof lastRowMs !== 'number' || !Number.isFinite(lastRowMs))) {
    throw new TypeError(`lastRowMs must be a finite number or null, got ${String(lastRowMs)}`);
  }

  const everWrote = lastRowMs !== null;
  const ageMs = everWrote ? nowMs - lastRowMs : null;
  // Inclusive at the boundary: a feed writing exactly on its threshold is keeping pace.
  const fresh = ageMs !== null && ageMs <= thresholdMs;

  let state;
  if (fresh) state = 'ok';
  else if (nowMs - startedMs < thresholdMs) state = 'starting';
  else state = 'stale';

  return { venue, state, ageMs, everWrote, thresholdMs };
}

/** Whole minutes, for a message a human reads at 3am. */
const minutes = (ms) => Math.round(ms / 60_000);

/** Key under which the last startup announcement is remembered, across restarts. */
export const STARTUP_STATE_KEY = 'watchdog:last_startup_notice_ms';

/**
 * Should this start be announced?
 *
 * An operator restarting a service wants to see it come back — that is the whole point of
 * the notification. But launchd `KeepAlive` restarts a *crashing* service every
 * `ThrottleInterval` (10s here), and an unguarded announcement would then post several
 * hundred messages an hour until somebody mutes the channel. Muting is permanent in
 * practice, and it takes the real staleness alerts with it.
 *
 * The gap therefore separates the two cases by the only signal that distinguishes them:
 * how recently the last start was. A human restarting twice inside a minute is doing
 * something deliberate and rare; a service restarting every ten seconds is looping. The
 * default is small enough that any genuine restart is still announced.
 *
 * `lastMs === null` (never announced) always announces — a first run must be heard.
 *
 * @param {{lastMs: number|null, nowMs: number, minGapMs: number}} args
 * @returns {boolean}
 */
export function shouldAnnounceStartup({ lastMs, nowMs, minGapMs }) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new TypeError(`nowMs must be a finite number, got ${String(nowMs)}`);
  }
  if (typeof minGapMs !== 'number' || !Number.isFinite(minGapMs) || minGapMs < 0) {
    throw new TypeError(`minGapMs must be a finite number >= 0, got ${String(minGapMs)}`);
  }
  if (lastMs === null || lastMs === undefined) return true;
  if (typeof lastMs !== 'number' || !Number.isFinite(lastMs)) {
    throw new TypeError(`lastMs must be a finite number or null, got ${String(lastMs)}`);
  }
  // A clock that moved backwards (NTP correction, a restored backup) would otherwise
  // suppress every announcement until wall-clock caught up. Treat it as "announce".
  if (nowMs < lastMs) return true;
  return nowMs - lastMs >= minGapMs;
}

/**
 * The startup announcement text.
 *
 * Carries the state it is reporting on rather than a bare "I am alive". An operator
 * reading this on a phone should be able to tell whether the restart landed somewhere
 * healthy without opening a laptop: which venues are actually being watched, whether each
 * one's feed is currently fresh, and what the retention window is.
 *
 * A watched venue with NO feed classification is reported as `no data yet`, which is the
 * honest reading on a fresh database and is distinct from a feed that is stale.
 *
 * @param {{venues: ReadonlyArray<string>, feeds: ReadonlyArray<object>,
 *          keepOppDays: number, nowMs: number}} args
 * @returns {string}
 */
export function startupMessage({ venues, feeds, keepOppDays, nowMs }) {
  const byVenue = new Map(feeds.map((f) => [f.venue, f]));
  const lines = venues.map((venue) => {
    const feed = byVenue.get(venue);
    if (feed === undefined) return `  ${venue}: no data yet`;
    if (feed.ageMs === null) return `  ${venue}: no rows yet (${feed.state})`;
    return `  ${venue}: ${feed.state}, last row ${minutes(feed.ageMs)} min ago`;
  });

  const watched = venues.length === 0 ? '  (no venues being watched — nothing has written rows)' : lines.join('\n');

  return (
    `gp-arb-bot watchdog STARTED at ${new Date(nowMs).toISOString()}\n` +
    `watching:\n${watched}\n` +
    `retention: ${keepOppDays === 0 ? 'disabled' : `${keepOppDays} days`}\n` +
    'You will get one message when a feed goes stale, and one when it recovers.'
  );
}

/**
 * De-duplicating alert policy.
 *
 * Suppression is keyed on the venue's remembered state, so a feed that recovers and fails
 * again kicks immediately rather than waiting out the previous timer — flapping is a real
 * signal and hiding it behind the first failure's cooldown would lose exactly the pattern
 * worth seeing.
 *
 * @param {{repeatMs: number}} opts how long before a still-down feed is re-reported
 * @returns {{next: (feed: object, nowMs: number) => object|null}}
 */
export function createKickPolicy({ repeatMs }) {
  if (typeof repeatMs !== 'number' || !Number.isFinite(repeatMs) || repeatMs < 0) {
    throw new TypeError(`repeatMs must be a finite number >= 0, got ${String(repeatMs)}`);
  }

  /** @type {Map<string, {state: string, lastKickMs: number}>} */
  const seen = new Map();

  return {
    /**
     * @param {{venue: string, state: string, ageMs: number|null}} feed
     * @param {number} nowMs
     * @returns {{kind: 'stale'|'recovered', venue: string, ageMs: number|null,
     *            message: string}|null} the alert to send, or null for silence
     */
    next(feed, nowMs) {
      const { venue, state, ageMs } = feed;

      // A warm-up carries no information either way: it must not raise an alert, and it
      // must not be mistaken for recovery from one that is already standing.
      if (state === 'starting') return null;

      const prior = seen.get(venue);

      if (state === 'stale') {
        const isNew = prior?.state !== 'stale';
        if (!isNew && nowMs - prior.lastKickMs < repeatMs) return null;

        seen.set(venue, { state: 'stale', lastKickMs: nowMs });
        const age = ageMs === null ? 'ever' : `${minutes(ageMs)} min`;
        return {
          kind: 'stale',
          venue,
          ageMs,
          message:
            `${venue} feed is STALE — no row written in ${age}. ` +
            (isNew ? 'The scanner may be dead, wedged, or silently reading a drifted payload.' : 'Still down.'),
        };
      }

      // state === 'ok'
      seen.set(venue, { state: 'ok', lastKickMs: nowMs });
      if (prior?.state !== 'stale') return null;
      return {
        kind: 'recovered',
        venue,
        ageMs,
        message: `${venue} feed has RECOVERED — rows are landing again.`,
      };
    },
  };
}

/**
 * Parse a comma-separated venue list.
 *
 * @param {string|undefined|null} raw
 * @returns {Array<string>|null} null when unset, so "not configured" stays distinct from
 *   "configured as empty"
 */
export function parseVenueList(raw) {
  if (raw === undefined || raw === null) return null;
  const parts = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return parts.length === 0 ? null : parts;
}

/**
 * Decide which venues this watchdog is responsible for.
 *
 * Defaulting to "whatever is already in the database" is what keeps the watchdog from
 * alerting forever about a venue nobody runs — Limitless has an adapter slot and no
 * scanner, and a monitor that cries about it every 30 minutes is a monitor that gets
 * turned off. Auto-discovery is re-run on every tick, so a scanner started later is
 * picked up without a restart.
 *
 * The cost of that default is the one failure it cannot see: a venue that never starts
 * writes no rows, so it is never watched. `GPA_WATCH_VENUES` exists for exactly that —
 * pin the list when "kalshi should be running" is a claim worth monitoring.
 *
 * @param {{configured: Array<string>|null, present: ReadonlyArray<string>,
 *          thresholds: Record<string, number>}} args
 * @returns {Array<string>}
 * @throws {Error} when a configured venue has no staleness threshold — silently skipping
 *   it would mean the operator asked for monitoring and got none
 */
export function resolveWatchedVenues({ configured, present, thresholds }) {
  const venues = configured ?? [...present];
  const unknown = venues.filter((v) => !Object.hasOwn(thresholds, v));
  if (unknown.length > 0) {
    throw new Error(
      `no staleness threshold for venue(s) ${unknown.join(', ')}. ` +
        `Known venues: ${Object.keys(thresholds).join(', ')}.`,
    );
  }
  return [...new Set(venues)];
}

/**
 * Newest `opportunities.ts` per venue.
 *
 * A venue with no rows is **absent** from the map rather than zero: zero would be read
 * downstream as "wrote at the epoch", i.e. maximally stale, which is a different claim
 * from "has never written" and calls for a different response.
 *
 * The map has a null prototype so a venue literally named `constructor` or `toString`
 * reads back as data instead of resolving into `Object.prototype`.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Record<string, number>}
 */
export function lastRowMsByVenue(db) {
  const rows = db.prepare('SELECT venue, MAX(ts) AS last_ts FROM opportunities GROUP BY venue').all();
  const out = Object.create(null);
  for (const row of rows) out[row.venue] = Number(row.last_ts);
  return out;
}
