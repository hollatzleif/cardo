// @vitest-environment jsdom
//
// Runs the FULL diagnose suite in CI.
//
// Until now the most thorough layer of checking Cardo has — 400+ checks — was
// reachable only by clicking a button in Settings → Diagnostics. It therefore
// never ran on a build agent, and a release could (and did) ship with parts of
// it broken. This file closes that gap: `pnpm test` now executes it.
//
// What this can and cannot prove: everything Tauri-bound (`core:*`, `env:*`,
// parts of `security:*`) has no bridge under jsdom and drops out. What remains
// is every tool self-test, every widget render in every variant, and the
// coverage gate — the pure checks, which are exactly the ones a build agent
// can be held to.
import { beforeAll, describe, expect, it } from 'vitest';
import { DIAGNOSE_CATEGORIES } from '@cardo/core';
import { initI18n } from '../i18n';
import { initHost } from '../host';
import { initProfiles } from '../assistant/profiles';
import { createMemoryDocStore } from '../assistant/api';
import { instantiateTools, liveTools } from '../host/tools';
import { useAppStore } from '../state/appStore';
import { runFullDiagnose } from './runDiagnose';

/**
 * Floor for the number of checks that must run headless.
 *
 * Its job is to catch SILENT LOSS: a broken import can make a whole category
 * evaluate to an empty array, and the panel would still report "all green"
 * because zero failures out of zero checks is a pass. Nothing else in the
 * suite notices a check that simply stopped existing.
 *
 * Set below the real count so ordinary additions don't churn it; raise it when
 * a batch of checks lands. It is a tripwire, not an exact expectation.
 *
 * Actual count at the time of writing: 403.
 */
const HEADLESS_CHECK_FLOOR = 390;

beforeAll(async () => {
  // The network is dead here; nothing may hang or crash because of it.
  globalThis.fetch = (() =>
    Promise.reject(new TypeError('headless diagnose: network is offline'))) as typeof fetch;

  await initI18n('de');
  const host = initHost();
  await initProfiles({ docs: createMemoryDocStore(), migrateNative: async () => false });

  instantiateTools();
  for (const tool of liveTools.values()) host.registry.register(tool);
  for (const id of liveTools.keys()) await host.registry.activate(id);

  await useAppStore.getState().init();
}, 60_000);

describe('the full diagnose suite runs headless', () => {
  it(
    'reports no failures, loses no checks and has no duplicate ids',
    async () => {
      const report = await runFullDiagnose({ includeNetwork: false });

      // 1. Nothing lost. Checked before the failure assertion because an empty
      //    suite would satisfy "no failures" while proving nothing at all.
      expect(
        report.results.length,
        `only ${report.results.length} checks ran, expected at least ${HEADLESS_CHECK_FLOOR}. ` +
          `A whole category may have silently dropped out.`,
      ).toBeGreaterThanOrEqual(HEADLESS_CHECK_FLOOR);

      // 2. No duplicate ids. Duplicates currently collide as React keys in the
      //    panel, so one silently hides the other.
      const seen = new Map<string, number>();
      for (const r of report.results) seen.set(r.id, (seen.get(r.id) ?? 0) + 1);
      const duplicates = [...seen].filter(([, n]) => n > 1).map(([id, n]) => `${id} ×${n}`);
      expect(duplicates, `duplicate check ids: ${duplicates.join(', ')}`).toEqual([]);

      // 3. Every category that produced results uses a known name — a typo
      //    would make a check invisible in both the panel and the report.
      const categories = new Set(report.results.map((r) => r.category));
      const unknown = [...categories].filter(
        (c) => !DIAGNOSE_CATEGORIES.includes(c as (typeof DIAGNOSE_CATEGORIES)[number]),
      );
      expect(unknown, `unknown categories: ${unknown.join(', ')}`).toEqual([]);

      // 4. And finally: nothing is red.
      const failures = report.results
        .filter((r) => r.status === 'fail')
        .map((r) => `${r.id}: ${r.detail ?? ''}`);
      expect(failures, `failing checks:\n${failures.join('\n')}`).toEqual([]);
    },
    120_000,
  );

  it('covers the tool and ui categories, not just the cheap ones', async () => {
    // Guards against the suite degrading into a handful of trivial checks
    // while still clearing the floor above.
    const report = await runFullDiagnose({ includeNetwork: false });
    const byCategory = new Map<string, number>();
    for (const r of report.results) {
      byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + 1);
    }
    expect(byCategory.get('tools') ?? 0).toBeGreaterThan(200);
    expect(byCategory.get('ui') ?? 0).toBeGreaterThan(100);
  }, 120_000);
});
