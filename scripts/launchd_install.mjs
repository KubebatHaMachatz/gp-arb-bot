#!/usr/bin/env node
/**
 * Install this repo's LaunchAgents.
 *
 *   node scripts/launchd_install.mjs [--dry-run] [--service scan-polymarket] [--node /path/to/node]
 *
 * Or, cwd-independently, from anywhere in the repo:
 *
 *   npm run launchd:install -- --dry-run
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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_NODE_CANDIDATES,
  flagValue,
  isDurableNodePath,
  labelFor,
  plistFor,
  plistPath,
} from '../lib/launchd.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = homedir();
const LOG_DIR = join(REPO, 'logs');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

/** Read a value-taking flag, or exit naming it. See lib/launchd.mjs for why. */
function requireFlag(name) {
  const { value, error } = flagValue(args, name);
  if (error) {
    const example = name === '--node' ? '/opt/homebrew/bin/node' : 'scan-polymarket';
    console.error(`${error}, e.g. ${name} ${example}`);
    process.exit(1);
  }
  return value;
}

const only = requireFlag('--service');
const override = requireFlag('--node');

const SERVICES = [
  { name: 'scan-polymarket', script: 'scripts/scan_polymarket.mjs' },
  { name: 'scan-kalshi', script: 'scripts/scan_kalshi.mjs' },
  { name: 'watchdog', script: 'scripts/watchdog.mjs' },
];

/** Minimum runtime this repo needs, from package.json's `engines`. */
const MIN_NODE = [22, 5];

/** `vX.Y.Z` → [X, Y], or null when the binary did not answer. */
function nodeVersionOf(path) {
  try {
    const out = execFileSync(path, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /^v(\d+)\.(\d+)\./.exec(out.trim());
    return m ? [Number(m[1]), Number(m[2])] : null;
  } catch {
    return null;
  }
}

const meetsMin = (v) => v !== null && (v[0] > MIN_NODE[0] || (v[0] === MIN_NODE[0] && v[1] >= MIN_NODE[1]));

/**
 * Pick the `node` the services will run under.
 *
 * An absolute path is required — launchd has a minimal PATH and no shell, so a bare
 * `node` resolves to nothing. But `process.execPath` alone is not good enough either: it
 * resolves symlinks onto whatever runtime is currently in front, which on this kind of
 * machine is frequently a version manager's or a tool's private directory. See
 * `isDurableNodePath` for why that breaks a LaunchAgent permanently and silently.
 */
function resolveNode() {
  if (override) {
    if (!override.startsWith('/')) {
      console.error(`--node must be an absolute path, got "${override}"`);
      process.exit(1);
    }
    const v = nodeVersionOf(override);
    if (!meetsMin(v)) {
      console.error(
        `--node ${override} is ${v ? `v${v.join('.')}` : 'not runnable'}; need >= ${MIN_NODE.join('.')}`,
      );
      process.exit(1);
    }
    return override;
  }

  for (const candidate of DEFAULT_NODE_CANDIDATES) {
    if (existsSync(candidate) && meetsMin(nodeVersionOf(candidate))) return candidate;
  }

  // Nothing durable qualified. Fall back to the running interpreter rather than refusing
  // to install, but say plainly what was chosen and what will break, because the failure
  // it invites is invisible when it happens.
  if (!isDurableNodePath(process.execPath, HOME)) {
    console.warn(
      `WARNING: no durable node >= ${MIN_NODE.join('.')} found in ${DEFAULT_NODE_CANDIDATES.join(', ')}.\n` +
        `  Falling back to ${process.execPath}, which lives in a hidden directory under your home —\n` +
        '  a version manager or a tool-managed runtime. If that path moves or is removed, these\n' +
        '  services stop starting, launchd retries forever, and nothing surfaces outside the system log.\n' +
        '  Prefer: brew install node, then re-run. Or pass --node /absolute/path/to/node.',
    );
  }
  return process.execPath;
}

const NODE = resolveNode();

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
