/**
 * Repo identity, read from `package.json` rather than duplicated in source.
 *
 * Deliberately small, but not a placeholder: the validation here is the shape every
 * later module follows — reject malformed input loudly at the boundary, name the
 * offending field in the message, and never silently fall back to a default. A bot that
 * quietly runs on a default it was never configured with is the failure mode this repo's
 * rules exist to prevent.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** `major.minor.patch`, nothing else — no `v` prefix, no prerelease/build suffix. */
const VERSION_RE = /^\d+\.\d+\.\d+$/;

const DEFAULT_PACKAGE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

/**
 * Parse the raw text of a `package.json` into `{ name, version }`.
 *
 * @param {string} text raw file contents
 * @returns {Readonly<{name: string, version: string}>} frozen
 * @throws {TypeError} if `text` is not a string
 * @throws {Error} if the text is not JSON, is not an object, or lacks a usable
 *   `name`/`version`
 */
export function parsePackageMeta(text) {
  if (typeof text !== 'string') {
    throw new TypeError('parsePackageMeta expects the raw package.json text as a string');
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`package.json is not valid JSON: ${cause.message}`, { cause });
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('package.json must be a JSON object');
  }

  const { name, version } = parsed;

  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('package.json "name" must be a non-empty string');
  }
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    throw new Error(
      `package.json "version" must look like major.minor.patch, got ${JSON.stringify(version)}`,
    );
  }

  return Object.freeze({ name, version });
}

/**
 * Read and validate a `package.json` from disk.
 *
 * @param {string} [path] defaults to this repo's own package.json
 * @returns {Readonly<{name: string, version: string}>} frozen
 * @throws {Error} if the file cannot be read, naming the path that failed
 */
export function readPackageMeta(path = DEFAULT_PACKAGE_PATH) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(`could not read package.json at ${path}: ${cause.message}`, { cause });
  }
  return parsePackageMeta(text);
}

/**
 * Render a one-line identity banner, e.g. `gp-arb-bot v0.0.1`.
 *
 * @param {{name: string, version: string}} meta
 * @returns {string}
 * @throws {Error} if `meta` lacks renderable `name`/`version` strings
 */
export function formatBanner(meta) {
  const name = meta?.name;
  const version = meta?.version;
  if (typeof name !== 'string' || name === '' || typeof version !== 'string' || version === '') {
    throw new Error('formatBanner expects { name, version } as non-empty strings');
  }
  return `${name} v${version}`;
}

const meta = readPackageMeta();

/** This package's name, from `package.json`. */
export const NAME = meta.name;

/** This package's version, from `package.json`. */
export const VERSION = meta.version;
