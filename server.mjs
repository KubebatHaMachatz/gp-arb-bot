#!/usr/bin/env node
/**
 * Dashboard + JSON API for the Phase 1 readout.
 *
 *   node server.mjs        # http://localhost:4324
 *
 * Two deliberate properties:
 *
 * - **Loopback by default.** `GPA_BIND` must be set explicitly to expose this on a
 *   network. The data is not secret, but nothing here is authenticated, so exposure is
 *   an opt-in decision rather than an accident of a default.
 * - **Read-only database handle.** The scanner is writing to the same file while this
 *   serves; a dashboard bug must not be able to corrupt a measurement run.
 */

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadConfig } from './lib/config.mjs';
import { openDb } from './lib/db.mjs';
import { handleApi } from './lib/server_routes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();

// Read-only: this process must never be able to write the measurement it is reporting.
// A read-only open of a missing file fails by design, so the likely first-run mistake
// (starting the dashboard before ever collecting) is turned into an instruction rather
// than a raw SQLite error code.
let db;
try {
  db = openDb(cfg.db, { readOnly: true, busyTimeoutMs: cfg.dbBusyTimeoutMs });
} catch (err) {
  if (!existsSync(cfg.db)) {
    console.error(
      `No database at ${cfg.db} yet.\n` +
        'The dashboard reads what the scanner collects, so run the scanner first:\n' +
        '  node scripts/scan_polymarket.mjs\n' +
        'or point GPA_DB at an existing database.',
    );
    process.exit(1);
  }
  throw err;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  const send = (status, body, type = 'application/json') => {
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      // Static, self-hosted page with no third-party assets.
      'x-content-type-options': 'nosniff',
    });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  try {
    if (url.pathname.startsWith('/api/')) {
      const { status, body } = handleApi(url, { db, cfg, nowMs: Date.now() });
      send(status, body);
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      send(200, await readFile(join(HERE, 'public', 'index.html'), 'utf8'), 'text/html; charset=utf-8');
      return;
    }

    send(404, { error: 'not found' });
  } catch (err) {
    // Never take the dashboard down over one bad request; the scanner is the thing that
    // must keep running, and an unhandled throw here would kill this process.
    send(500, { error: err.message });
  }
});

server.listen(cfg.port, cfg.bind, () => {
  const loopback = cfg.bind === '127.0.0.1';
  // Print the HOSTNAME, not the bind address. They reach the same server, but some
  // embedded browsers whitelist `localhost` and reject the equivalent IP literal, which
  // makes a 127.0.0.1 link unclickable. The bind address is unchanged — that is the
  // security property, and it is set by GPA_BIND, not by how the URL is spelled.
  const host = loopback ? 'localhost' : cfg.bind;
  const where = loopback ? 'loopback only' : `bound to ${cfg.bind}`;
  console.log(`gp-arb-bot dashboard on http://${host}:${cfg.port} (${where})`);
  console.log(`reading ${cfg.db} (read-only); clear floor ${cfg.minNetEdge}`);
});

function shutdown(signal) {
  console.log(`\n${signal}: closing`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
