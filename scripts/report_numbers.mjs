#!/usr/bin/env node
/**
 * Prints every number quoted in the README, from a fresh run.
 *
 * The README's rule is that no figure appears in it unless this script
 * reproduces it, so there is exactly one place to check when something drifts.
 *
 *   npm run numbers
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = join(ROOT, '.vitest-report.json');

console.log('Running the test suite with coverage. This takes a moment.\n');

const run = spawnSync(
  process.execPath,
  [
    join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    '--coverage',
    '--reporter=json',
    `--outputFile=${REPORT}`,
  ],
  { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CI: 'true', NO_COLOR: '1' } },
);

if (run.status !== 0) {
  process.stderr.write(run.stderr ?? '');
  console.error('\nThe test suite did not pass, so these numbers would be meaningless.');
  process.exit(1);
}

const summaryPath = join(ROOT, 'coverage', 'coverage-summary.json');
if (!existsSync(summaryPath) || !existsSync(REPORT)) {
  console.error('Expected coverage/coverage-summary.json and a vitest report; one is missing.');
  process.exit(1);
}

const coverage = JSON.parse(readFileSync(summaryPath, 'utf8')).total;
const report = JSON.parse(readFileSync(REPORT, 'utf8'));

const files = new Set(
  report.testResults?.map((r) => r.name?.replace(/\\/g, '/').split('/tests/').pop()) ?? [],
);

const pct = (n) => `${n.toFixed(2)}%`;

console.log('README figures');
console.log('==============\n');
console.log(`  tests passing        ${report.numPassedTests} / ${report.numTotalTests}`);
console.log(`  test files           ${files.size}`);
console.log('');
console.log(`  statement coverage   ${pct(coverage.statements.pct)}  (${coverage.statements.covered}/${coverage.statements.total})`);
console.log(`  branch coverage      ${pct(coverage.branches.pct)}  (${coverage.branches.covered}/${coverage.branches.total})`);
console.log(`  function coverage    ${pct(coverage.functions.pct)}  (${coverage.functions.covered}/${coverage.functions.total})`);
console.log(`  line coverage        ${pct(coverage.lines.pct)}  (${coverage.lines.covered}/${coverage.lines.total})`);
console.log('');
console.log('  Thresholds enforced in vitest.config.ts: 85% lines/statements/functions, 80% branches.');
console.log('  The build fails below them, so these are floors rather than a snapshot.');

rmSync(REPORT, { force: true });
