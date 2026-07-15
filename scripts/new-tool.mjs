#!/usr/bin/env node
// Scaffolds a new first-party tool with everything the gates demand:
// manifest (selfTests, privacy, tour), package.json, index.tsx skeleton
// (ctx closure, variant switch, <id>.context command, runSelfTest),
// logic.ts + logic.test.ts, i18n blocks (en+de), toolFactories entry and
// the desktop dependency. After running: `pnpm install` once, then fill in
// the widget/logic. Usage:
//
//   node scripts/new-tool.mjs <kebab-id> --en "Name" --de "Name"
//
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const [id, ...rest] = process.argv.slice(2);
if (!id || !/^[a-z][a-z0-9-]*$/.test(id)) {
  console.error('usage: node scripts/new-tool.mjs <kebab-id> [--en "Name"] [--de "Name"]');
  process.exit(1);
}
const arg = (flag, fallback) => {
  const i = rest.indexOf(flag);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : fallback;
};
const titleCase = id.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const nameEn = arg('--en', titleCase);
const nameDe = arg('--de', nameEn);

const dir = join(root, 'packages/tools', id);
if (existsSync(dir)) {
  console.error(`❌ packages/tools/${id} already exists`);
  process.exit(1);
}

/** kebab-case → PascalCase for the factory alias. */
const pascal = id.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('');

/* ── 1 · Tool package ─────────────────────────────────────────────────── */

mkdirSync(join(dir, 'src'), { recursive: true });

writeFileSync(
  join(dir, 'manifest.json'),
  JSON.stringify(
    {
      id,
      nameKey: `tool.${id}.name`,
      descriptionKey: `tool.${id}.description`,
      version: '1.0.0',
      minAppVersion: '0.1.0',
      permissions: [],
      privacy: { level: 'green', network: [], summaryKey: `tool.${id}.privacy` },
      widgets: [{ id: 'main', defaultSize: { w: 4, h: 3 }, minSize: { w: 2, h: 2 }, variants: [] }],
      commands: [`${id}.context`],
      selfTests: [
        { id: 'render', titleKey: `tool.${id}.test.render` },
        { id: 'storage', titleKey: `tool.${id}.test.storage` },
      ],
      tourSteps: [
        { anchor: `widget:${id}:main`, titleKey: `tool.${id}.tour.title`, bodyKey: `tool.${id}.tour.body` },
      ],
      setupSteps: [],
    },
    null,
    2,
  ) + '\n',
);

writeFileSync(
  join(dir, 'package.json'),
  JSON.stringify(
    {
      name: `@cardo/tool-${id}`,
      version: '1.0.0',
      private: true,
      type: 'module',
      main: 'src/index.tsx',
      types: 'src/index.tsx',
      dependencies: { '@cardo/plugin-api': 'workspace:*', zod: '^3.24.1' },
      peerDependencies: { react: '^18.3.1' },
    },
    null,
    2,
  ) + '\n',
);

writeFileSync(
  join(dir, 'src/logic.ts'),
  `/** Pure, unit-testable logic for the ${id} tool. */

/** Replace with the tool's real logic; every pure function gets a test. */
export function placeholder(value: number): number {
  return value;
}
`,
);

writeFileSync(
  join(dir, 'src/logic.test.ts'),
  `import { describe, expect, it } from 'vitest';
import { placeholder } from './logic';

describe('${id} logic', () => {
  it('placeholder passes values through', () => {
    expect(placeholder(7)).toBe(7);
  });
});
`,
);

writeFileSync(
  join(dir, 'src/index.tsx'),
  `import { useEffect, useState } from 'react';
import { z } from 'zod';
import type {
  CardoTool,
  CommandResult,
  SelfTestContext,
  SelfTestResult,
  ToolContext,
  WidgetProps,
} from '@cardo/plugin-api';
import manifest from '../manifest.json';

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  function Widget(props: WidgetProps) {
    const [ready, setReady] = useState(false);
    useEffect(() => {
      setReady(ctx !== null);
    }, []);
    // Variant switch: extend via manifest widgets[].variants + cases here.
    switch (props.variant) {
      default:
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', height: '100%' }}>
            <strong>{t('tool.${id}.name')}</strong>
            <span className="c-muted">{ready ? t('tool.${id}.widget.empty') : '…'}</span>
          </div>
        );
    }
  }

  async function registerCommands(context: ToolContext): Promise<void> {
    context.commands.register({
      id: '${id}.context',
      titleKey: 'tool.${id}.command.context',
      palette: false,
      params: z.object({}),
      selfTestParams: {},
      async run(): Promise<CommandResult> {
        // Summarize the tool's current state for the assistant prompt.
        return { ok: true, data: { contextText: t('tool.${id}.widget.empty') } };
      },
    });
  }

  return {
    manifest: manifest as CardoTool['manifest'],
    async activate(context: ToolContext) {
      ctx = context;
      await registerCommands(context);
    },
    deactivate() {
      ctx = null;
    },
    Widget,
    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'render':
          return typeof Widget === 'function' && Widget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget export contract violated' };
        case 'storage': {
          await testCtx.storage.set('selftest', { probe: true });
          const doc = await testCtx.storage.get<{ probe: boolean }>('selftest');
          await testCtx.storage.delete('selftest');
          return doc?.probe === true
            ? { status: 'pass' }
            : { status: 'fail', detail: 'storage roundtrip failed' };
        }
        default:
          return { status: 'fail', detail: \`unknown test "\${testId}"\` };
      }
    },
  };
}
`,
);

/* ── 2 · i18n blocks (en + de) ────────────────────────────────────────── */

const i18nBlocks = {
  en: {
    name: nameEn,
    description: `TODO: describe ${nameEn}.`,
    privacy: 'Works fully local. Nothing leaves your device.',
    'widget.empty': 'Nothing here yet.',
    'command.context': `${nameEn}: current state`,
    'test.render': 'Widget renders',
    'test.storage': 'Storage roundtrip works',
    'tour.title': nameEn,
    'tour.body': `TODO: one-line tour hint for ${nameEn}.`,
  },
  de: {
    name: nameDe,
    description: `TODO: ${nameDe} beschreiben.`,
    privacy: 'Arbeitet vollständig lokal. Nichts verlässt dein Gerät.',
    'widget.empty': 'Noch nichts hier.',
    'command.context': `${nameDe}: aktueller Stand`,
    'test.render': 'Widget wird dargestellt',
    'test.storage': 'Speicher-Roundtrip funktioniert',
    'tour.title': nameDe,
    'tour.body': `TODO: Ein-Zeilen-Tour-Hinweis für ${nameDe}.`,
  },
};

/** "a.b.c": v pairs → nested object. */
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

for (const locale of ['en', 'de']) {
  const path = join(root, `packages/i18n/locales/${locale}/common.json`);
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  doc.tool ??= {};
  if (doc.tool[id]) {
    console.error(`❌ i18n block tool.${id} already exists in ${locale}`);
    process.exit(1);
  }
  doc.tool[id] = unflatten(i18nBlocks[locale]);
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
}

/* ── 3 · Host registration ────────────────────────────────────────────── */

const toolsTsPath = join(root, 'apps/desktop/src/host/tools.ts');
let toolsTs = readFileSync(toolsTsPath, 'utf8');
const importLine = `import { createTool as create${pascal}Tool } from '@cardo/tool-${id}';\n`;
const lastImport = toolsTs.lastIndexOf("from '@cardo/tool-");
const lineEnd = toolsTs.indexOf('\n', lastImport) + 1;
toolsTs = toolsTs.slice(0, lineEnd) + importLine + toolsTs.slice(lineEnd);
const factoryKey = /^[a-z][a-z0-9]*$/.test(id) ? id : `'${id}'`;
toolsTs = toolsTs.replace(/(\nexport const toolFactories[^]*?)(\n};)/, `$1\n  ${factoryKey}: create${pascal}Tool,$2`);
writeFileSync(toolsTsPath, toolsTs);

const desktopPkgPath = join(root, 'apps/desktop/package.json');
const desktopPkg = JSON.parse(readFileSync(desktopPkgPath, 'utf8'));
desktopPkg.dependencies[`@cardo/tool-${id}`] = 'workspace:*';
desktopPkg.dependencies = Object.fromEntries(
  Object.entries(desktopPkg.dependencies).sort(([a], [b]) => a.localeCompare(b)),
);
writeFileSync(desktopPkgPath, JSON.stringify(desktopPkg, null, 2) + '\n');

console.log(`✅ scaffolded packages/tools/${id}`);
console.log('   next: pnpm install && pnpm check:manifests && pnpm check:i18n');
console.log(`   then: implement src/logic.ts + Widget, extend selfTests/commands`);
