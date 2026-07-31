/**
 * Complete-set grouping — shared by every venue.
 *
 * Nothing here branches on venue name. Both venues express the same two shapes: a binary
 * market's YES+NO pair, and a mutually-exclusive group whose complete set is the YES leg
 * of every member. Adapters differ only in how they LABEL those shapes — Polymarket with
 * `negRiskMarketID`, Kalshi with an explicit `mutually_exclusive` flag — but the rule for
 * deciding whether a group is COMPLETE is identical, and a per-venue copy of that rule is
 * exactly how the two would silently drift apart.
 */

import { KIND_BINARY, KIND_NEG_RISK } from './arb.mjs';

/**
 * Build the complete sets present in a batch of normalized rows.
 *
 * A group is DROPPED rather than priced when it is not a complete set. That is not
 * conservatism for its own sake: a complete set pays exactly $1 *because* it covers
 * every outcome, so pricing a partial group compares the cost of some outcomes against a
 * payout that requires all of them — it understates cost and invents an edge that cannot
 * be redeemed.
 *
 * Neg-risk completeness is checked against `negRiskGroupSize` — the membership count the
 * venue itself declares for the group — and NOT against a floor like "at least 2". Two
 * legs of a 51-outcome race cost about 40c and would otherwise look like a 60c risk-free
 * edge on a set that can never be redeemed. A group whose size is unknown (`null`) is
 * treated as incomplete, so the safe answer is the default.
 *
 * @param {Array<object>} rows
 * @param {{withDrops?: boolean}} [opts]
 * @returns {Array<object>|{sets: Array<object>, dropped: Array<object>}}
 */
export function groupIntoSets(rows, { withDrops = false } = {}) {
  const sets = [];
  const dropped = [];

  const byCondition = new Map();
  const byNegRiskGroup = new Map();

  for (const row of rows) {
    if (!byCondition.has(row.conditionId)) byCondition.set(row.conditionId, []);
    byCondition.get(row.conditionId).push(row);

    if (row.negRisk && row.outcome === 'Yes') {
      if (!byNegRiskGroup.has(row.eventKey)) byNegRiskGroup.set(row.eventKey, []);
      byNegRiskGroup.get(row.eventKey).push(row);
    }
  }

  const priceable = (legs) => legs.every((l) => l.category !== null);

  for (const [conditionId, legs] of byCondition) {
    const outcomes = legs.map((l) => l.outcome);
    if (legs.length !== 2 || !outcomes.includes('Yes') || !outcomes.includes('No')) {
      dropped.push({ eventKey: conditionId, kind: KIND_BINARY, reason: 'incomplete_binary' });
      continue;
    }
    if (!priceable(legs)) {
      dropped.push({ eventKey: conditionId, kind: KIND_BINARY, reason: 'unmapped_fee_type' });
      continue;
    }
    // Yes first, so leg order is stable across runs and matches the neg-risk convention.
    const ordered = [...legs].sort((a, b) => (a.outcome === 'Yes' ? -1 : 1));
    sets.push({ eventKey: conditionId, kind: KIND_BINARY, legs: ordered });
  }

  for (const [eventKey, legs] of byNegRiskGroup) {
    const declared = legs[0].negRiskGroupSize;
    // Exact match, not a floor. A short group is the dangerous case: it prices cheaply
    // and therefore looks like an enormous edge. A group longer than declared means the
    // venue's own count disagrees with what we assembled, which is equally untrustworthy.
    if (legs.length < 2 || !Number.isInteger(declared) || legs.length !== declared) {
      dropped.push({
        eventKey,
        kind: KIND_NEG_RISK,
        reason: 'incomplete_neg_risk',
        have: legs.length,
        declared: Number.isInteger(declared) ? declared : null,
      });
      continue;
    }
    if (!priceable(legs)) {
      dropped.push({ eventKey, kind: KIND_NEG_RISK, reason: 'unmapped_fee_type' });
      continue;
    }
    sets.push({ eventKey, kind: KIND_NEG_RISK, legs });
  }

  return withDrops ? { sets, dropped } : sets;
}
