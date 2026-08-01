#!/usr/bin/env node
/**
 * Remove this repo's LaunchAgents.
 *
 *   node scripts/launchd_uninstall.mjs [--service scan-polymarket]
 *
 * Or, cwd-independently, from anywhere in the repo:
 *
 *   npm run launchd:uninstall
 *
 * Unloads each service and deletes its plist. The database and the logs are left alone —
 * uninstalling the scheduler is not a request to destroy the measurement it collected,
 * and that data is the entire input to the Phase 2 decision.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';

import { SERVICES, flagValue, labelFor, plistPath } from '../lib/launchd.mjs';

const HOME = homedir();
const args = process.argv.slice(2);
// A trailing `--service` must not fall through to "not supplied": that would uninstall
// every service when one was named, tearing down a measurement run mid-week.
const { value: only, error: flagError } = flagValue(args, '--service');
if (flagError) {
  console.error(`${flagError}, e.g. --service scan-polymarket`);
  process.exit(1);
}

// Uninstall acts on EVERY known service by default, not just the default-install set:
// "remove it" must be able to remove something a previous `--service scan-kalshi`
// installed, or that agent lingers and keeps writing to the database.
const names = SERVICES.map((s) => s.name);
const selected = only ? names.filter((n) => n === only) : names;
if (selected.length === 0) {
  console.error(`unknown service "${only}". Known: ${names.join(', ')}`);
  process.exit(1);
}

for (const name of selected) {
  const label = labelFor(name);
  const path = plistPath(label, HOME);

  try {
    execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${label}`], { stdio: 'ignore' });
    console.log(`unloaded ${label}`);
  } catch {
    console.log(`${label} was not loaded`);
  }

  if (existsSync(path)) {
    rmSync(path);
    console.log(`removed ${path}`);
  }
}

console.log('the database and logs were left in place');
