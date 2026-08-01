#!/usr/bin/env node
/**
 * coverage-gate.mjs — the pre-GA coverage gate (Increment 4).
 *
 * Runs the server suite under node's built-in coverage reporter and fails
 * when LINE coverage drops below the configured threshold (default 90%).
 * The gate is deliberately threshold-based (not a diff check) so a PR that
 * adds untested code cannot silently lower the bar.
 *
 * Usage: node scripts/security/coverage-gate.mjs [threshold]
 * Exit 0 = pass, 1 = fail (with the per-file offenders listed).
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', '..', 'server');
const THRESHOLD = Number(process.argv[2] ?? process.env.COVERAGE_THRESHOLD ?? 90);

let output;
try {
  output = execFileSync('node', ['--test', '--experimental-test-coverage'], {
    cwd: SERVER,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300_000,
  });
} catch (err) {
  // Coverage run exits non-zero when tests fail — surface both.
  output = err.stdout ?? '';
  process.stderr.write(err.stderr ?? '');
}

// Parse the summary line: "# all files | line | branch | funcs |"
const summary = output.split('\n').find((l) => l.startsWith('# all files'));
if (!summary) {
  console.error('coverage-gate: could not parse the coverage summary.\n' + output.slice(-2000));
  process.exit(1);
}
const cols = summary.split('|').map((c) => c.trim());
const line = Number.parseFloat(cols[1]);
const branch = Number.parseFloat(cols[2]);
const funcs = Number.parseFloat(cols[3]);

console.log(`coverage-gate: line ${line}% (threshold ${THRESHOLD}%) · branch ${branch}% · functions ${funcs}%`);
if (line >= THRESHOLD) {
  console.log(`coverage-gate: PASS`);
  process.exit(0);
}

// List the worst offenders below the threshold for the PR author.
console.log(`coverage-gate: FAIL — line coverage ${line}% < ${THRESHOLD}%`);
for (const line2 of output.split('\n')) {
  const m = line2.match(/^#\s+(\S+\.js)\s+\|\s+([\d.]+)\s+\|/);
  if (m && Number.parseFloat(m[2]) < THRESHOLD) {
    console.log(`  low: ${m[1]} at ${m[2]}%`);
  }
}
process.exit(1);
