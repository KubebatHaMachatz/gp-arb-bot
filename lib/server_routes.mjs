/**
 * Route handling for the dashboard's JSON API, separated from the HTTP plumbing so it is
 * testable without binding a port.
 *
 * Every endpoint is read-only. The server opens the database with a **read-only handle**
 * (see `server.mjs`), so a dashboard bug cannot corrupt a measurement run in progress.
 */

import {
  capacityBinding,
  categoryBreakdown,
  densityByHour,
  edgeDistribution,
  recentClears,
  summarize,
} from './stats.mjs';

/** Windows the dashboard offers, in hours. `0` means "everything". */
export const WINDOWS = Object.freeze({ '1h': 1, '24h': 24, '7d': 168, all: 0 });

const DEFAULT_WINDOW = '24h';

/**
 * Resolve a `?window=` value to an absolute `sinceMs`.
 *
 * An unrecognised window falls back to the default rather than throwing — a mistyped
 * query string should not blank the dashboard — but a recognised one is honoured
 * exactly, so the number on screen always matches the label above it.
 *
 * @param {string|null|undefined} window
 * @param {number} nowMs
 * @returns {{window: string, sinceMs: number|undefined}}
 */
export function resolveWindow(window, nowMs) {
  const key = Object.hasOwn(WINDOWS, window ?? '') ? window : DEFAULT_WINDOW;
  const hours = WINDOWS[key];
  return { window: key, sinceMs: hours === 0 ? undefined : nowMs - hours * 3_600_000 };
}

/**
 * Answer one API request.
 *
 * @param {{pathname: string, searchParams: URLSearchParams}} url
 * @param {{db: object, cfg: object, nowMs: number}} ctx
 * @returns {{status: number, body: object}}
 */
export function handleApi(url, { db, cfg, nowMs }) {
  const { pathname, searchParams } = url;
  const { window, sinceMs } = resolveWindow(searchParams.get('window'), nowMs);
  const venue = searchParams.get('venue') ?? undefined;
  const minNetEdge = cfg.minNetEdge;
  const scope = { sinceMs, venue, minNetEdge };

  switch (pathname) {
    case '/api/summary':
      return {
        status: 200,
        body: {
          window,
          sinceMs: sinceMs ?? null,
          minNetEdge,
          generatedAtMs: nowMs,
          ...summarize(db, scope),
        },
      };

    case '/api/edge-distribution':
      return { status: 200, body: { window, buckets: edgeDistribution(db, { sinceMs, venue }) } };

    case '/api/density':
      return { status: 200, body: { window, hours: densityByHour(db, scope) } };

    case '/api/categories':
      return { status: 200, body: { window, categories: categoryBreakdown(db, scope) } };

    case '/api/capacity':
      return { status: 200, body: { window, ...capacityBinding(db, { sinceMs, venue }) } };

    case '/api/recent-clears': {
      const limit = Number(searchParams.get('limit') ?? 50);
      return {
        status: 200,
        body: {
          window,
          // A mistyped ?limit= must not 500 the panel.
          clears: recentClears(db, { ...scope, limit: Number.isFinite(limit) ? limit : 50 }),
        },
      };
    }

    default:
      return { status: 404, body: { error: `no such endpoint: ${pathname}` } };
  }
}
