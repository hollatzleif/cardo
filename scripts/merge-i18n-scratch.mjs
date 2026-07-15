#!/usr/bin/env node
// Merges agent-produced i18n scratch files into the locale catalogs.
//   <dir>/<tool-id>.json          → REPLACES the whole tool.<id> subtree
//   <dir>/<tool-id>.partial.json  → DEEP-MERGES new keys into tool.<id>
// Shape per file: {"en": {<flat keys>}, "de": {<flat keys>}}
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/merge-i18n-scratch.mjs <scratch-dir>');
  process.exit(1);
}

function unflatten(flat) {
  const out = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    let node = out;
    for (const part of parts.slice(0, -1)) node = node[part] ??= {};
    node[parts.at(-1)] = value;
  }
  return out;
}

function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] = deepMerge(target[key] ?? {}, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const catalogs = {};
for (const locale of ['en', 'de']) {
  catalogs[locale] = JSON.parse(
    readFileSync(join(root, `packages/i18n/locales/${locale}/common.json`), 'utf8'),
  );
}

for (const file of files.sort()) {
  const partial = file.endsWith('.partial.json');
  const toolId = file.replace(/\.partial\.json$|\.json$/, '');
  const scratch = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  for (const locale of ['en', 'de']) {
    if (!scratch[locale]) {
      console.error(`❌ ${file}: missing "${locale}"`);
      process.exit(1);
    }
    // Tolerate agents writing full paths ("tool.<id>.name") instead of
    // relative keys ("name") – strip the redundant prefix.
    const prefix = `tool.${toolId}.`;
    const normalized = Object.fromEntries(
      Object.entries(scratch[locale]).map(([key, value]) => [
        key.startsWith(prefix) ? key.slice(prefix.length) : key,
        value,
      ]),
    );
    const block = unflatten(normalized);
    const tools = (catalogs[locale].tool ??= {});
    if (partial) {
      tools[toolId] = deepMerge(tools[toolId] ?? {}, block);
    } else {
      tools[toolId] = block;
    }
  }
  console.log(`merged ${file} (${partial ? 'partial' : 'replace'})`);
}

for (const locale of ['en', 'de']) {
  writeFileSync(
    join(root, `packages/i18n/locales/${locale}/common.json`),
    JSON.stringify(catalogs[locale], null, 2) + '\n',
  );
}
console.log('✅ merged into en+de catalogs');
