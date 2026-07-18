// @vitest-environment jsdom
//
// Coverage gate (CI): every command the AI assistant may invoke MUST ship with
// selfTestParams, so the diagnostics actually exercise it. A new tool that adds
// an assistant command without a self-test turns this test red — that is the
// hard release gate the plan calls for (runs as part of `pnpm test`).
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../i18n';
import { initHost } from '../host';
import { toolFactories } from '../host/tools';
import { findUncoveredCommands } from './coverageChecks';

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  if (typeof g.ResizeObserver !== 'function') {
    g.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
});

describe('diagnose coverage gate', () => {
  it('every assistant-visible command has selfTestParams', async () => {
    await initI18n('de');
    const host = initHost();
    const uncovered = await findUncoveredCommands(Object.values(toolFactories), host.services);
    expect(
      uncovered,
      `assistant commands missing selfTestParams:\n${uncovered.join('\n')}`,
    ).toEqual([]);
  });
});
