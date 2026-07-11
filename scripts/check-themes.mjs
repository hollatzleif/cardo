#!/usr/bin/env node
// Every theme JSON must define every required primitive token.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED = [
  'base', 'surface-0', 'surface-1', 'surface-2', 'text', 'text-muted',
  'accent-1', 'accent-2', 'accent-3', 'accent-4', 'accent-5', 'accent-6', 'accent-7', 'accent-8',
  'success', 'warning', 'danger', 'info',
];
const HEX = /^#[0-9a-fA-F]{6}$/;

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages/themes');
let failed = false;
const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'package.json');
for (const file of files) {
  const theme = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const missing = REQUIRED.filter((t) => !theme.palette?.[t]);
  const invalid = Object.entries(theme.palette ?? {}).filter(([, v]) => !HEX.test(v));
  if (missing.length) { failed = true; console.error(`❌ ${file}: missing tokens: ${missing.join(', ')}`); }
  if (invalid.length) { failed = true; console.error(`❌ ${file}: invalid color values: ${invalid.map(([k]) => k).join(', ')}`); }
  if (!theme.license?.spdx || !theme.license?.source) { failed = true; console.error(`❌ ${file}: missing license info`); }
}
if (failed) process.exit(1);
console.log(`✅ themes: ${files.length} theme(s) complete (${REQUIRED.length} tokens each).`);
