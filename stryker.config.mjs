/**
 * Stryker mutation-testing config.
 *
 * `mutate` MUST stay `lib/**` and not `lib/*` — the narrower glob silently excludes every
 * subdirectory (e.g. `lib/adapters/`) from every mutation run, and the score still comes
 * back looking healthy because the excluded files are simply never mutated. A sibling
 * repo shipped that bug and trusted the resulting number for two phases before catching
 * it. Re-check this glob after any directory-layout change.
 */
export default {
  testRunner: 'command',
  commandRunner: {
    command: 'npm test',
  },
  mutate: ['lib/**/*.mjs'],
  reporters: ['html', 'clear-text', 'progress'],
  htmlReporter: {
    fileName: 'reports/mutation/mutation.html',
  },
  coverageAnalysis: 'off',
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
};
