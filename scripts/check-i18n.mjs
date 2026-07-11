#!/usr/bin/env node
// Fails if any locale is missing keys present in another locale (EN is the reference).
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const localesDir = join(root, 'packages/i18n/locales');

function flatten(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null ? flatten(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

const languages = readdirSync(localesDir);
const keysByLang = new Map();
for (const lang of languages) {
  const keys = new Set();
  for (const file of readdirSync(join(localesDir, lang))) {
    const data = JSON.parse(readFileSync(join(localesDir, lang, file), 'utf8'));
    for (const key of flatten(data, `${file.replace('.json', '')}:`)) keys.add(key);
  }
  keysByLang.set(lang, keys);
}

const reference = keysByLang.get('en');
if (!reference) {
  console.error('❌ i18n: reference locale "en" not found');
  process.exit(1);
}

let failed = false;
for (const [lang, keys] of keysByLang) {
  const missing = [...reference].filter((k) => !keys.has(k));
  const extra = [...keys].filter((k) => !reference.has(k));
  if (missing.length) {
    failed = true;
    console.error(`❌ i18n: "${lang}" is missing ${missing.length} key(s):\n  ${missing.join('\n  ')}`);
  }
  if (extra.length) {
    failed = true;
    console.error(`❌ i18n: "${lang}" has ${extra.length} key(s) not in "en":\n  ${extra.join('\n  ')}`);
  }
}
if (failed) process.exit(1);
console.log(`✅ i18n: ${languages.length} locale(s) complete, ${reference.size} keys each.`);
