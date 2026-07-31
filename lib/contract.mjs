/**
 * Payload contract-drift detection.
 *
 * The failure this exists to catch is silent. When a venue renames or drops a field, the
 * adapter reads `undefined` at every use site, and `undefined` flows onward as "no ask" —
 * which is indistinguishable from an honestly empty book. Nothing throws. The scanner
 * stays connected, keeps its counters climbing, and records nothing. A week of that
 * produces a dataset that looks complete and says the opportunity rate is zero, which is
 * the exact answer the Phase 1 gate is trying to measure. A wrong "no" is expensive here:
 * it kills the project quietly.
 *
 * **An absent key is drift. A key present with a `null` value is normal data.**
 *
 * That distinction is the entire design. `best_ask: null` is the venue correctly saying
 * "nothing is offered", and it happens on most books most of the time — treating it as
 * drift would fire an alert continuously and the channel would be muted within a day.
 * Only `Object.hasOwn` draws the line in the right place: `in` would accept `toString`
 * and every other inherited name as a satisfied contract, and `!== undefined` would
 * reject a legitimate null.
 *
 * (`{a: undefined}` counts as PRESENT here. `JSON.parse` never produces an undefined
 * value, so for real venue payloads the case is unreachable; `hasOwn` is the stated rule
 * and is applied without exception rather than special-cased into something subtler.)
 */

/**
 * Which required keys are absent from a payload.
 *
 * @param {unknown} payload
 * @param {ReadonlyArray<string>} required
 * @returns {Array<string>} the absent keys, in the order given
 * @throws {TypeError} when `required` is not an array — a mistyped contract that silently
 *   checked nothing would report "no drift" forever, and nobody would learn it was never
 *   looking. That is a worse failure than the one this module exists to catch.
 */
export function missingKeys(payload, required) {
  if (!Array.isArray(required)) {
    throw new TypeError(`required must be an array of key names, got ${String(required)}`);
  }
  // A non-object payload — a bare `null` body, or a 502 HTML page parsed into a string —
  // satisfies no key at all. Reported as total drift rather than thrown, because a
  // TypeError here would kill the scan loop over a transient upstream error.
  if (payload === null || typeof payload !== 'object') return [...required];

  return required.filter((key) => !Object.hasOwn(payload, key));
}

const DEFAULT_REPEAT_MS = 900_000;

/**
 * Build a drift detector for one payload shape.
 *
 * Reports are de-duplicated **by which keys are missing**, not merely by "something is
 * wrong". A drifted field is drifted on every frame — thousands per minute — so reporting
 * each one is a self-inflicted denial of service on the alert channel. But suppressing on
 * a bare boolean would hide a second, unrelated schema change behind the first one for a
 * whole repeat interval, so the signature is part of the key.
 *
 * A clean payload deliberately does **not** reset that suppression. It is tempting — "the
 * field came back, so a fresh failure is news" — and it is wrong for a message stream.
 * Partial drift is the common shape: a venue drops a field from delta frames but keeps it
 * in snapshots, so clean and drifted frames interleave. Clearing on each clean one made a
 * measured 1,000 reports where 1 was due, inside a 15-minute repeat window, over two
 * seconds of traffic. Suppression is therefore purely time-based per signature, which
 * still surfaces every DISTINCT drift immediately.
 *
 * @param {{required: ReadonlyArray<string>, label: string, onDrift: Function,
 *          repeatMs?: number}} opts
 * @returns {{check: (payload: unknown, nowMs: number) => boolean, stats: () => object}}
 */
export function createDriftDetector({ required, label, onDrift, repeatMs = DEFAULT_REPEAT_MS }) {
  if (!Array.isArray(required)) {
    throw new TypeError(`required must be an array of key names, got ${String(required)}`);
  }
  if (typeof label !== 'string' || label.trim() === '') {
    throw new TypeError(`label must be a non-empty string, got ${String(label)}`);
  }
  if (typeof onDrift !== 'function') {
    throw new TypeError(`onDrift must be a function, got ${String(onDrift)}`);
  }
  if (typeof repeatMs !== 'number' || !Number.isFinite(repeatMs) || repeatMs < 0) {
    throw new TypeError(`repeatMs must be a finite number >= 0, got ${String(repeatMs)}`);
  }

  /** @type {Map<string, number>} missing-key signature → when it was last reported */
  const reportedAt = new Map();
  let checked = 0;
  let drifted = 0;
  let reported = 0;

  return {
    /**
     * @param {unknown} payload
     * @param {number} nowMs
     * @returns {boolean} whether the payload satisfies the contract
     */
    check(payload, nowMs) {
      checked += 1;
      const missing = missingKeys(payload, required);
      if (missing.length === 0) return true;

      drifted += 1;
      const signature = missing.join(',');
      const last = reportedAt.get(signature);
      if (last !== undefined && nowMs - last < repeatMs) return false;

      reportedAt.set(signature, nowMs);
      reported += 1;
      try {
        onDrift({
          label,
          missing,
          nowMs,
          message:
            `contract drift on ${label}: absent key(s) ${signature}. ` +
            'A renamed or dropped field reads as "no data" everywhere downstream, so the ' +
            'scanner keeps running and silently records nothing.',
        });
      } catch {
        // The detector sits in the message hot path. A broken alert sink must not take
        // the scanner down with it; the counters below still record that this happened.
      }
      return false;
    },

    /** @returns {{checked: number, drifted: number, reported: number}} */
    stats: () => ({ checked, drifted, reported }),
  };
}
