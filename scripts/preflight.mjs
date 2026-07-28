#!/usr/bin/env node
// Pre-demo check: is the Cardo installation on THIS machine ready?
//
// The main diagnose suite runs against a scratch database and so proves the
// code is correct, not that the installation works. This asks the other
// question — is the CLI logged in, is a second instance holding the database,
// is the installed bundle the version you just built.
//
// Kept in plain JS with no dependencies, like every other script here, so it
// runs without a build step. It only formats; all check logic lives in
// crates/cardo-doctor so the app and this command can never disagree.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const ICON = { pass: '✓', warn: '!', fail: '✗', skip: '⏭' };
const COLOR = { pass: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m', skip: '\x1b[90m' };
const RESET = '\x1b[0m';
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function paint(status, text) {
  return useColor ? `${COLOR[status] ?? ''}${text}${RESET}` : text;
}

function version() {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

// Everything after `--` is handed through to the doctor unchanged, so
// `pnpm preflight --skip claude` works without this script knowing the flags.
const passthrough = process.argv.slice(2);

const args = ['run', '-q', '--release', '-p', 'cardo-doctor', '--', '--json'];
const expected = version();
if (expected && !passthrough.some((a) => a.startsWith('--expect-version'))) {
  args.push('--expect-version', expected);
}
args.push(...passthrough);

// The release profile is cached, but the very first run has to compile it.
process.stderr.write('Preflight: checking your installation…\n');

const run = spawnSync('cargo', args, { cwd: root, encoding: 'utf8' });

if (run.error) {
  console.error(`\nCould not run cargo: ${run.error.message}`);
  console.error('Is the Rust toolchain installed?');
  process.exit(1);
}

let report;
try {
  // Cargo may prepend build progress on stdout in some configurations; take
  // the JSON object only.
  const start = run.stdout.indexOf('{');
  report = JSON.parse(run.stdout.slice(start));
} catch {
  console.error('\nThe doctor did not return usable JSON.\n');
  if (run.stdout.trim()) console.error(run.stdout.trim());
  if (run.stderr.trim()) console.error(run.stderr.trim());
  process.exit(1);
}

const { checks, summary } = report;

console.log('');
for (const check of checks) {
  const id = check.id.replace(/^env:/, '');
  const icon = ICON[check.status] ?? '?';
  const line = `  ${icon}  ${id.padEnd(16)} ${check.detail ?? ''}`.trimEnd();
  console.log(paint(check.status, line));
}

console.log(
  `\n  ${summary.passed} ok · ${summary.warned} warnings · ` +
    `${summary.failed} failed · ${summary.skipped} skipped`,
);

if (summary.failed > 0) {
  console.log(paint('fail', '\n  NOT ready to demo — fix the ✗ entries above.\n'));
  process.exit(1);
}
if (summary.warned > 0) {
  console.log(paint('warn', '\n  Usable, but check the warnings above.\n'));
  process.exit(0);
}
console.log(paint('pass', '\n  Ready to demo.\n'));
