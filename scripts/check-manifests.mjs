#!/usr/bin/env node
// Every tool manifest must be structurally valid, ship self-tests and a
// privacy declaration, and only reference i18n keys that actually exist.
// Mirrors packages/plugin-api/src/manifest.ts (kept in plain JS so this
// runs without a build step; the zod schema stays the source of truth
// at runtime).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const toolsDir = join(root, 'packages/tools');
const locale = JSON.parse(readFileSync(join(root, 'packages/i18n/locales/en/common.json'), 'utf8'));

const KEBAB = /^[a-z][a-z0-9-]*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const COMMAND = /^[a-z][a-z0-9-]*\.[a-zA-Z][a-zA-Z0-9-]*$/;
const PERMISSIONS = new Set([
  'notifications', 'scheduler', 'audio', 'file-read', 'file-write', 'network', 'global-shortcut',
]);

let failed = false;
const fail = (tool, msg) => { failed = true; console.error(`❌ ${tool}: ${msg}`); };
const resolveKey = (key) =>
  key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), locale);
const checkKey = (tool, key, field) => {
  if (typeof key !== 'string' || !key) fail(tool, `${field} must be a non-empty i18n key`);
  else if (typeof resolveKey(key) !== 'string') fail(tool, `${field} references missing i18n key "${key}"`);
};
const checkSize = (s) => s && Number.isInteger(s.w) && Number.isInteger(s.h)
  && s.w >= 1 && s.w <= 24 && s.h >= 1 && s.h <= 24;

const tools = readdirSync(toolsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

for (const tool of tools) {
  const path = join(toolsDir, tool, 'manifest.json');
  if (!existsSync(path)) { fail(tool, 'manifest.json missing'); continue; }
  let m;
  try {
    m = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(tool, `manifest.json is not valid JSON: ${err.message}`);
    continue;
  }

  if (m.id !== tool) fail(tool, `manifest id "${m.id}" must match folder name`);
  if (!KEBAB.test(m.id ?? '')) fail(tool, 'id must be kebab-case');
  checkKey(tool, m.nameKey, 'nameKey');
  checkKey(tool, m.descriptionKey, 'descriptionKey');
  if (!SEMVER.test(m.version ?? '')) fail(tool, 'version must be semver (x.y.z)');
  if (!SEMVER.test(m.minAppVersion ?? '')) fail(tool, 'minAppVersion must be semver (x.y.z)');

  for (const p of m.permissions ?? []) {
    if (!PERMISSIONS.has(p)) fail(tool, `unknown permission "${p}"`);
  }

  // Privacy declaration is mandatory (transparency principle).
  if (!m.privacy) { fail(tool, 'privacy declaration missing'); }
  else {
    const { level, network = [], summaryKey } = m.privacy;
    if (level !== 'green' && level !== 'yellow') fail(tool, `privacy.level must be "green" or "yellow", got "${level}"`);
    if (level === 'yellow' && network.length === 0) fail(tool, 'privacy.level "yellow" requires at least one network declaration');
    if (level === 'green' && network.length > 0) fail(tool, 'privacy.level "green" must not declare network hosts');
    for (const n of network) {
      if (!n.host) fail(tool, 'network declaration missing host');
      checkKey(tool, n.dataKey, `network[${n.host ?? '?'}].dataKey`);
    }
    checkKey(tool, summaryKey, 'privacy.summaryKey');
    if ((m.permissions ?? []).includes('network') && level !== 'yellow') {
      fail(tool, 'permission "network" requires privacy.level "yellow"');
    }
  }

  if (!Array.isArray(m.widgets) || m.widgets.length === 0) fail(tool, 'at least one widget required');
  for (const w of m.widgets ?? []) {
    if (!KEBAB.test(w.id ?? '')) fail(tool, `widget id "${w.id}" must be kebab-case`);
    if (!checkSize(w.defaultSize)) fail(tool, `widget "${w.id}": defaultSize must be integers 1–24`);
    if (!checkSize(w.minSize)) fail(tool, `widget "${w.id}": minSize must be integers 1–24`);
  }

  for (const c of m.commands ?? []) {
    if (!COMMAND.test(c)) fail(tool, `command "${c}" must be "<tool>.<action>"`);
    else if (c.split('.')[0] !== m.id) fail(tool, `command "${c}" must be namespaced under tool id "${m.id}"`);
  }

  // Self-tests are mandatory: a tool without them does not pass review.
  if (!Array.isArray(m.selfTests) || m.selfTests.length === 0) fail(tool, 'selfTests are mandatory (min 1)');
  for (const t of m.selfTests ?? []) {
    if (!KEBAB.test(t.id ?? '')) fail(tool, `selfTest id "${t.id}" must be kebab-case`);
    checkKey(tool, t.titleKey, `selfTest[${t.id ?? '?'}].titleKey`);
  }

  for (const s of m.tourSteps ?? []) {
    if (!s.anchor) fail(tool, 'tourStep missing anchor');
    checkKey(tool, s.titleKey, `tourStep[${s.anchor ?? '?'}].titleKey`);
    checkKey(tool, s.bodyKey, `tourStep[${s.anchor ?? '?'}].bodyKey`);
  }
}

if (failed) process.exit(1);
console.log(`✅ manifests: ${tools.length} tool(s) valid.`);
