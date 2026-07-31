/**
 * launchd service definition — pure rendering, no filesystem access.
 *
 * The install/uninstall scripts do the I/O; everything decidable lives here so it can be
 * tested without touching `~/Library/LaunchAgents`.
 *
 * **The rule this module enforces in code rather than in prose: no secrets in a plist.**
 * Files under `~/Library/LaunchAgents` are world-readable 644. A token written into one is
 * a token published to every account on the machine, and it persists in Time Machine
 * backups long after the variable itself is rotated. `assertNoSecrets` therefore refuses
 * to render an environment containing a credential-shaped key, and `plistFor` calls it on
 * every render — a documented convention would eventually be forgotten; a thrown error
 * will not be.
 *
 * Credentials reach a service by other means: a `.env` read by the process at 0600, or
 * `launchctl setenv` in a user session.
 */

/** Reverse-DNS prefix for every service this repo installs. */
export const LABEL_PREFIX = 'com.gp-arb-bot';

/** Seconds launchd waits between respawns; caps a crash loop's CPU cost. */
const THROTTLE_SECONDS = 10;

/**
 * Substrings that mark an environment variable as carrying a credential.
 *
 * Deliberately broad. A false positive costs one renamed variable; a false negative
 * publishes a live key to every account on the machine.
 */
const SECRET_MARKERS = [
  'TOKEN',
  'SECRET',
  'KEY',
  'PASSWORD',
  'PASSPHRASE',
  'CREDENTIAL',
  'PRIVATE',
  'AUTH',
];

/**
 * Read a flag that takes a value, without guessing when the value is missing.
 *
 * `argv[i + 1]` is `undefined` past the end of the array, and treating that as "the flag
 * was not supplied" is silent substitution in the dangerous direction: a trailing
 * `--service` selects EVERY service rather than one, so an install bootstraps three
 * LaunchAgents and an uninstall tears down a running measurement. A trailing `--node`
 * discards a pinned runtime and auto-detects a different one — the same class of silent
 * swap the durable-path check exists to prevent.
 *
 * A following token that itself looks like a flag is treated as missing too, so
 * `--service --dry-run` reports the real problem instead of "unknown service --dry-run".
 *
 * Pure: returns the error rather than exiting, so the whole surface is testable.
 *
 * @param {ReadonlyArray<string>} argv
 * @param {string} name
 * @returns {{value: string|null, error: string|null}} `value` is null when absent
 */
export function flagValue(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return { value: null, error: null };
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) {
    return { value: null, error: `${name} requires a value` };
  }
  return { value: next, error: null };
}

/**
 * System prefixes to prefer for the `node` a service runs, most-preferred first.
 *
 * These are package-manager and OS locations: they are upgraded in place and their path
 * does not change with the runtime version.
 */
export const DEFAULT_NODE_CANDIDATES = Object.freeze([
  '/opt/homebrew/bin/node',
  '/usr/local/bin/node',
  '/usr/bin/node',
]);

/**
 * Will this `node` still be at this path next month?
 *
 * `process.execPath` is the obvious choice for "the node that ran this script", and it is
 * the wrong one to write into a plist. It resolves symlinks, so on a machine using a
 * version manager — or a tool that ships its own private runtime — it lands on something
 * like `~/.nvm/versions/node/v22.5.0/bin/node` or `~/.hermes/node/bin/node`. Those paths
 * are versioned, privately owned, and routinely moved or deleted on upgrade.
 *
 * When one disappears the LaunchAgent breaks **permanently and silently**: launchd cannot
 * spawn the program, `KeepAlive` retries every `ThrottleInterval` forever, and the only
 * evidence is in the system log. A measurement run that dies that way looks exactly like
 * a week of no opportunities.
 *
 * The rule targets per-user runtime managers specifically: a hidden directory *under the
 * user's home*. A hidden segment elsewhere is a system layout decision and not this
 * script's business to second-guess.
 *
 * @param {string} nodePath
 * @param {string} home
 * @returns {boolean}
 */
export function isDurableNodePath(nodePath, home) {
  const root = home.endsWith('/') ? home : `${home}/`;
  if (!nodePath.startsWith(root)) return true;
  const relative = nodePath.slice(root.length);
  return !relative.split('/').some((segment) => segment.startsWith('.'));
}

/**
 * XML-escape a value for a plist `<string>`.
 *
 * `&` is replaced FIRST. Any other order re-escapes the ampersands introduced by the
 * earlier replacements — `<` would become `&lt;` and then `&amp;lt;`, producing a plist
 * that parses cleanly but carries the wrong string, which is harder to notice than one
 * that fails outright.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * Does this variable name look like it holds a credential?
 *
 * @param {string} key
 * @returns {boolean}
 */
export function isSecretKey(key) {
  const upper = String(key).toUpperCase();
  return SECRET_MARKERS.some((marker) => upper.includes(marker));
}

/**
 * Refuse an environment that would publish a credential.
 *
 * @param {Record<string, string>} environment
 * @throws {Error} naming every offending key — never its value
 */
export function assertNoSecrets(environment) {
  const offenders = Object.keys(environment ?? {}).filter(isSecretKey);
  if (offenders.length === 0) return;
  throw new Error(
    `refusing to write ${offenders.join(', ')} into a launchd plist: plists are ` +
      'world-readable (644) and are captured by Time Machine. Supply credentials via a ' +
      '0600 .env read by the process, or launchctl setenv.',
  );
}

/**
 * Build the launchd label for a service.
 *
 * @param {string} name e.g. `scan-polymarket`
 * @returns {string}
 * @throws {TypeError} on whitespace or a path separator — launchd refuses both at load
 *   time with a diagnostic that names neither
 */
export function labelFor(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError(`service name must be a non-empty string, got ${String(name)}`);
  }
  if (/[\s/\\]/.test(name)) {
    throw new TypeError(`service name must not contain whitespace or a path separator, got "${name}"`);
  }
  return `${LABEL_PREFIX}.${name}`;
}

/**
 * Where a per-user LaunchAgent plist lives.
 *
 * @param {string} label
 * @param {string} home
 * @returns {string}
 */
export function plistPath(label, home) {
  return `${home}/Library/LaunchAgents/${label}.plist`;
}

/** Every path launchd resolves must be absolute; it has no working directory of its own. */
function assertAbsolute(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string, got ${String(value)}`);
  }
  if (!value.startsWith('/')) {
    throw new TypeError(
      `${field} must be an absolute path, got "${value}". launchd resolves a relative ` +
        'path against "/", so the service would start, fail to find its target, and die ' +
        'in a KeepAlive loop visible only in the system log.',
    );
  }
}

/**
 * Render a complete LaunchAgent plist.
 *
 * `RunAtLoad` + `KeepAlive` are not optional extras here: a measurement run that stops
 * silently at its first crash yields a partial week that is indistinguishable from a
 * complete one, and that partial week is the input to the Phase 2 go/no-go.
 *
 * @param {{label: string, programArguments: ReadonlyArray<string>, workingDirectory: string,
 *          stdoutPath: string, stderrPath: string, environment?: Record<string, string>,
 *          throttleSeconds?: number}} args
 * @returns {string} the plist XML
 * @throws {TypeError} on an argument launchd would reject at load time
 * @throws {Error} when `environment` carries a credential-shaped key
 */
export function plistFor({
  label,
  programArguments,
  workingDirectory,
  stdoutPath,
  stderrPath,
  environment = {},
  throttleSeconds = THROTTLE_SECONDS,
}) {
  if (typeof label !== 'string' || label.trim() === '') {
    throw new TypeError(`label must be a non-empty string, got ${String(label)}`);
  }
  if (!Array.isArray(programArguments) || programArguments.length === 0) {
    throw new TypeError(`programArguments must be a non-empty array, got ${String(programArguments)}`);
  }
  for (const [i, arg] of programArguments.entries()) {
    if (typeof arg !== 'string' || arg === '') {
      throw new TypeError(`programArguments[${i}] must be a non-empty string, got ${String(arg)}`);
    }
  }
  // The executable and the script it runs are both resolved by launchd, not by a shell.
  assertAbsolute(programArguments[0], 'programArguments[0]');
  if (programArguments.length > 1) assertAbsolute(programArguments[1], 'programArguments[1]');
  assertAbsolute(workingDirectory, 'workingDirectory');
  assertAbsolute(stdoutPath, 'stdoutPath');
  assertAbsolute(stderrPath, 'stderrPath');
  if (!Number.isInteger(throttleSeconds) || throttleSeconds < 1) {
    throw new TypeError(`throttleSeconds must be an integer >= 1, got ${String(throttleSeconds)}`);
  }

  assertNoSecrets(environment);

  const args = programArguments.map((a) => `\n    <string>${xmlEscape(a)}</string>`).join('');

  const envKeys = Object.keys(environment);
  const envBlock =
    envKeys.length === 0
      ? ''
      : `\n  <key>EnvironmentVariables</key>\n  <dict>${envKeys
          .map((k) => `\n    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(environment[k])}</string>`)
          .join('')}\n  </dict>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(workingDirectory)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrPath)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>${throttleSeconds}</integer>${envBlock}
</dict>
</plist>
`;
}
