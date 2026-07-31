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

import { labelFor, plistPath } from '../lib/launchd.mjs';

const HOME = homedir();
const args = process.argv.slice(2);
const only = args.includes('--service') ? args[args.indexOf('--service') + 1] : null;

const SERVICES = ['scan-polymarket', 'scan-kalshi', 'watchdog'];

const selected = only ? SERVICES.filter((s) => s === only) : SERVICES;
if (selected.length === 0) {
  console.error(`unknown service "${only}". Known: ${SERVICES.join(', ')}`);
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
