#!/usr/bin/env node
/**
 * Install this repo's LaunchAgents.
 *
 *   node scripts/launchd_install.mjs [--dry-run] [--service scan-polymarket]
 *
 * Three services, each its own process so a stalled feed on one venue cannot touch
 * another: the Polymarket scanner, the Kalshi scanner, and the watchdog.
 *
 * `--dry-run` prints each plist and writes nothing, which is the sane way to inspect what
 * is about to be installed into `~/Library/LaunchAgents`.
 *
 * Credentials are never written here. `plistFor` refuses an environment carrying a
 * credential-shaped key, because these files are world-readable 644 — see lib/launchd.mjs.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { labelFor, plistFor, plistPath } from '../lib/launchd.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = homedir();
const LOG_DIR = join(REPO, 'logs');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const only = args.includes('--service') ? args[args.indexOf('--service') + 1] : null;

const SERVICES = [
  { name: 'scan-polymarket', script: 'scripts/scan_polymarket.mjs' },
  { name: 'scan-kalshi', script: 'scripts/scan_kalshi.mjs' },
  { name: 'watchdog', script: 'scripts/watchdog.mjs' },
];

// `process.execPath` rather than a bare `node`: launchd runs with a minimal PATH that
// generally does not include a version manager's shims, so `node` alone resolves to
// nothing and the service dies in a KeepAlive loop visible only in the system log.
const NODE = process.execPath;

const selected = only ? SERVICES.filter((s) => s.name === only) : SERVICES;
if (selected.length === 0) {
  console.error(`unknown service "${only}". Known: ${SERVICES.map((s) => s.name).join(', ')}`);
  process.exit(1);
}

/** Services whose plist was written but which launchctl refused to load. */
const failures = [];

if (!dryRun) {
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(join(HOME, 'Library', 'LaunchAgents'), { recursive: true });
}

for (const svc of selected) {
  const label = labelFor(svc.name);
  const path = plistPath(label, HOME);
  const xml = plistFor({
    label,
    programArguments: [NODE, join(REPO, svc.script)],
    workingDirectory: REPO,
    stdoutPath: join(LOG_DIR, `${svc.name}.log`),
    stderrPath: join(LOG_DIR, `${svc.name}.err`),
  });

  if (dryRun) {
    console.log(`--- ${path} ---\n${xml}`);
    continue;
  }

  writeFileSync(path, xml, { mode: 0o644 });
  // `bootout` first so a re-install replaces a running service rather than failing with
  // "service already loaded". A non-zero exit here just means it was not loaded.
  try {
    execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${label}`], { stdio: 'ignore' });
  } catch {
    // not currently loaded — the normal case on a first install
  }

  // A failure on one service must not abort the loop. Throwing here would leave the
  // remaining services untouched and the already-written plists loaded or not depending
  // on where it stopped — a half-installed state reported only as a stack trace.
  try {
    execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, path], { stdio: 'inherit' });
    console.log(`installed ${label} -> ${path}`);
  } catch (err) {
    failures.push(label);
    console.error(`FAILED to load ${label}: ${err.message}`);
    console.error(`  the plist is written at ${path}; load it with:`);
    console.error(`  launchctl bootstrap gui/${process.getuid()} ${path}`);
  }
}

if (dryRun) console.log('(dry run — nothing was written or loaded)');

if (failures.length > 0) {
  console.error(`\n${failures.length} of ${selected.length} service(s) failed to load: ${failures.join(', ')}`);
  process.exit(1);
}
