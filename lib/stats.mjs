/**
 * Read-side aggregations over `opportunities` — the Phase 1 readout.
 *
 * These queries exist to answer one question: **is the post-fee, depth-cleared
 * opportunity density worth the capital?** Everything here is shaped to make that
 * answerable honestly, which means a few deliberate choices:
 *
 * - **Skips are counted, not hidden.** The freshness gate rejects a large share of
 *   evaluations; reporting only what got priced would flatter every rate.
 * - **The clear rate is over what was PRICEABLE**, not over everything, so a bad feed
 *   day cannot masquerade as a bad market day.
 * - **The fee-free bucket is reported apart.** It is structurally different — the one
 *   place taker arbitrage still works cleanly — and averaging it into charged categories
 *   would hide exactly the signal the decision turns on.
 * - **`bestNetEdge` is `null`, never 0, on an empty window.** Zero is a claim; absence
 *   is not.
 */

/**
 * Net-edge histogram buckets, in ascending order, each `[min, max)`.
 *
 * Resolution is finest around breakeven because that is the decision boundary: "missed
 * by a tenth of a cent" and "missed by a dollar" are different findings, and a coarse
 * bucket would report them identically.
 */
export const EDGE_BUCKETS = Object.freeze(
  [
    { label: '< -5c', min: Number.NEGATIVE_INFINITY, max: -0.05 },
    { label: '-5c..-1c', min: -0.05, max: -0.01 },
    { label: '-1c..0', min: -0.01, max: 0 },
    { label: '0..+1c', min: 0, max: 0.01 },
    { label: '+1c..+5c', min: 0.01, max: 0.05 },
    { label: '>= +5c', min: 0.05, max: Number.POSITIVE_INFINITY },
  ].map((b) => Object.freeze(b)),
);

/** Categories whose taker rate is genuinely zero, tracked apart from charged ones. */
const FEE_FREE_CATEGORIES = new Set(['geopolitics']);

const UNKNOWN_CATEGORY = '(unknown)';

/** Hard ceiling on any row-returning endpoint, so one request cannot pull the table. */
const MAX_ROWS = 500;

/**
 * @param {number} netEdge
 * @returns {string} the bucket label
 */
export function bucketForEdge(netEdge) {
  if (typeof netEdge !== 'number' || !Number.isFinite(netEdge)) {
    throw new TypeError(`netEdge must be a finite number, got ${String(netEdge)}`);
  }
  // The last bucket is open-ended, so it is the fallback by construction rather than by
  // a defensive branch nothing can reach.
  for (let i = 0; i < EDGE_BUCKETS.length - 1; i += 1) {
    if (netEdge < EDGE_BUCKETS[i].max) return EDGE_BUCKETS[i].label;
  }
  return EDGE_BUCKETS[EDGE_BUCKETS.length - 1].label;
}

/**
 * @param {unknown} minNetEdge
 * @returns {number}
 */
function assertMinNetEdge(minNetEdge) {
  if (
    typeof minNetEdge !== 'number' ||
    !Number.isFinite(minNetEdge) ||
    minNetEdge <= 0 ||
    minNetEdge > 1
  ) {
    throw new TypeError(
      `minNetEdge must be a finite number in (0, 1], got ${String(minNetEdge)}`,
    );
  }
  return minNetEdge;
}

/**
 * Build the shared `WHERE` fragment and its bindings.
 *
 * @param {{sinceMs?: number, venue?: string}} opts
 * @returns {{clause: string, params: Array<number|string>}}
 */
function windowClause({ sinceMs, venue }) {
  const conditions = [];
  const params = [];
  if (sinceMs !== undefined && sinceMs !== null) {
    if (typeof sinceMs !== 'number' || !Number.isFinite(sinceMs)) {
      throw new TypeError(`sinceMs must be a finite number, got ${String(sinceMs)}`);
    }
    conditions.push('ts >= ?');
    params.push(sinceMs);
  }
  if (venue !== undefined && venue !== null) {
    conditions.push('venue = ?');
    params.push(venue);
  }
  return {
    clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

/**
 * Headline counts over a window.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{sinceMs?: number, venue?: string, minNetEdge: number}} opts
 * @returns {object}
 */
export function summarize(db, { sinceMs, venue, minNetEdge } = {}) {
  const floor = assertMinNetEdge(minNetEdge);
  const { clause, params } = windowClause({ sinceMs, venue });

  const row = db
    .prepare(
      `SELECT
         COUNT(*)                                                      AS total,
         SUM(CASE WHEN skip_reason IS NULL THEN 1 ELSE 0 END)          AS priced,
         SUM(CASE WHEN skip_reason IS NOT NULL THEN 1 ELSE 0 END)      AS skipped,
         SUM(CASE WHEN net_edge >= ? THEN 1 ELSE 0 END)                AS clears,
         MAX(net_edge)                                                 AS best_net_edge,
         SUM(CASE WHEN net_edge >= ? THEN capacity_usd ELSE 0 END)     AS clearing_capacity
       FROM opportunities ${clause}`,
    )
    .get(floor, floor, ...params);

  const total = row.total ?? 0;
  const priced = row.priced ?? 0;
  const skipped = row.skipped ?? 0;
  const clears = row.clears ?? 0;

  return {
    total,
    priced,
    skipped,
    clears,
    // Over TOTAL: what fraction of evaluations the freshness gate rejected.
    skipRate: total === 0 ? 0 : skipped / total,
    // Over PRICED: a bad feed day must not read as a bad market day.
    clearRate: priced === 0 ? 0 : clears / priced,
    // null, not 0 — absence of an edge is not an edge of zero.
    bestNetEdge: row.best_net_edge ?? null,
    clearingCapacityUsd: row.clearing_capacity ?? 0,
  };
}

/**
 * Net-edge histogram over priced sets. Skipped sets make no edge claim and are excluded.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{sinceMs?: number, venue?: string}} opts
 * @returns {Array<{label: string, count: number}>} every bucket, in declared order
 */
export function edgeDistribution(db, { sinceMs, venue } = {}) {
  const { clause, params } = windowClause({ sinceMs, venue });
  const where = clause ? `${clause} AND net_edge IS NOT NULL` : 'WHERE net_edge IS NOT NULL';

  const counts = new Map(EDGE_BUCKETS.map((b) => [b.label, 0]));
  for (const row of db.prepare(`SELECT net_edge FROM opportunities ${where}`).iterate(...params)) {
    const label = bucketForEdge(row.net_edge);
    counts.set(label, counts.get(label) + 1);
  }
  // Empty buckets are still emitted: a gap in the histogram is information.
  return EDGE_BUCKETS.map((b) => ({ label: b.label, count: counts.get(b.label) }));
}

/**
 * Per-UTC-hour activity.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{sinceMs?: number, venue?: string, minNetEdge: number}} opts
 * @returns {Array<object>} ascending by hour
 */
export function densityByHour(db, { sinceMs, venue, minNetEdge } = {}) {
  const floor = assertMinNetEdge(minNetEdge);
  const { clause, params } = windowClause({ sinceMs, venue });

  return db
    .prepare(
      `SELECT
         (ts / 3600000) * 3600000                                 AS hour_ms,
         COUNT(*)                                                 AS total,
         SUM(CASE WHEN skip_reason IS NULL THEN 1 ELSE 0 END)     AS priced,
         SUM(CASE WHEN skip_reason IS NOT NULL THEN 1 ELSE 0 END) AS skipped,
         SUM(CASE WHEN net_edge >= ? THEN 1 ELSE 0 END)           AS clears
       FROM opportunities ${clause}
       GROUP BY hour_ms
       ORDER BY hour_ms`,
    )
    .all(floor, ...params)
    .map((r) => ({
      hourMs: r.hour_ms,
      total: r.total,
      priced: r.priced,
      skipped: r.skipped,
      clears: r.clears,
    }));
}

/**
 * Per-category activity, joining legs back to their market metadata.
 *
 * The join fans out over legs, so every count is over DISTINCT opportunity ids — a naive
 * `COUNT(*)` would weight a 30-leg neg-risk set thirty times more heavily than a binary
 * pair and quietly skew the whole readout toward big groups.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{sinceMs?: number, venue?: string, minNetEdge: number}} opts
 * @returns {Array<object>} descending by priced count
 */
export function categoryBreakdown(db, { sinceMs, venue, minNetEdge } = {}) {
  const floor = assertMinNetEdge(minNetEdge);
  const { clause, params } = windowClause({ sinceMs, venue });
  const scoped = clause.replace(/\bts\b/g, 'o.ts').replace(/\bvenue\b/g, 'o.venue');

  return db
    .prepare(
      `SELECT
         COALESCE(m.category, '${UNKNOWN_CATEGORY}')                        AS category,
         COUNT(DISTINCT CASE WHEN o.skip_reason IS NULL THEN o.id END)      AS priced,
         COUNT(DISTINCT CASE WHEN o.net_edge >= ? THEN o.id END)            AS clears,
         MAX(o.net_edge)                                                    AS best_net_edge,
         SUM(CASE WHEN o.net_edge >= ? THEN o.capacity_usd ELSE 0 END)      AS clearing_capacity
       FROM opportunities o
       JOIN opportunity_legs l ON l.opportunity_id = o.id
       LEFT JOIN markets m ON m.token_id = l.token_id AND m.venue = o.venue
       ${scoped}
       GROUP BY category
       ORDER BY priced DESC, category`,
    )
    .all(floor, floor, ...params)
    .map((r) => ({
      category: r.category,
      priced: r.priced,
      clears: r.clears,
      bestNetEdge: r.best_net_edge ?? null,
      clearingCapacityUsd: r.clearing_capacity ?? 0,
      // Surfaced explicitly so the reader never has to remember which categories are
      // exempt: this bucket is the one where taker arbitrage still works cleanly.
      feeFree: FEE_FREE_CATEGORIES.has(r.category),
    }));
}

/**
 * What limited the size — a thin book, or the notional cap?
 *
 * They call for opposite responses (wait vs add capital) and the capacity number alone
 * cannot distinguish them.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{sinceMs?: number, venue?: string}} opts
 * @returns {{book: number, notional: number, unsized: number, medianCapacityUsd: number|null}}
 */
export function capacityBinding(db, { sinceMs, venue } = {}) {
  const { clause, params } = windowClause({ sinceMs, venue });

  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN binding_leg IS NOT NULL AND binding_leg <> 'notional' THEN 1 ELSE 0 END) AS book,
         SUM(CASE WHEN binding_leg = 'notional' THEN 1 ELSE 0 END)                              AS notional,
         SUM(CASE WHEN binding_leg IS NULL THEN 1 ELSE 0 END)                                   AS unsized
       FROM opportunities ${clause}`,
    )
    .get(...params);

  const sizes = db
    .prepare(
      `SELECT capacity_usd FROM opportunities
       ${clause ? `${clause} AND` : 'WHERE'} capacity_usd IS NOT NULL
       ORDER BY capacity_usd`,
    )
    .all(...params)
    .map((r) => r.capacity_usd);

  return {
    book: row.book ?? 0,
    notional: row.notional ?? 0,
    unsized: row.unsized ?? 0,
    medianCapacityUsd: sizes.length === 0 ? null : sizes[Math.floor((sizes.length - 1) / 2)],
  };
}

/**
 * The newest clearing sets.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{sinceMs?: number, venue?: string, minNetEdge: number, limit?: number}} opts
 * @returns {Array<object>} newest first
 */
export function recentClears(db, { sinceMs, venue, minNetEdge, limit = 50 } = {}) {
  const floor = assertMinNetEdge(minNetEdge);
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new TypeError(`limit must be a finite number, got ${String(limit)}`);
  }
  const bounded = Math.min(MAX_ROWS, Math.max(1, Math.floor(limit)));
  const { clause, params } = windowClause({ sinceMs, venue });
  const where = clause ? `${clause} AND net_edge >= ?` : 'WHERE net_edge >= ?';

  return db
    .prepare(
      `SELECT id, venue, event_key, ts, kind, leg_count, gross_cost, total_fee, net_edge,
              capacity_shares, capacity_usd, binding_leg, book_age_ms
       FROM opportunities ${where}
       ORDER BY ts DESC, id DESC
       LIMIT ?`,
    )
    .all(...params, floor, bounded)
    .map((r) => ({
      id: r.id,
      venue: r.venue,
      eventKey: r.event_key,
      ts: r.ts,
      kind: r.kind,
      legCount: r.leg_count,
      grossCost: r.gross_cost,
      totalFee: r.total_fee,
      netEdge: r.net_edge,
      capacityShares: r.capacity_shares,
      capacityUsd: r.capacity_usd,
      bindingLeg: r.binding_leg,
      bookAgeMs: r.book_age_ms,
    }));
}
