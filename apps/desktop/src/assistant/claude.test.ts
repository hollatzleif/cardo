import { describe, expect, it } from 'vitest';
import { claudeCheck, claudeCheckCached, claudeGenerate, CLAUDE_ERROR_MARKER } from './api';
import { MODEL_CATALOG, modelById } from './models';

/**
 * Claude bridge (api.ts) – non-Tauri behavior + catalog wiring.
 * The Rust commands themselves (claude_check / claude_generate) are covered
 * on the Rust side; here we pin the guarded degradation contract that keeps
 * browser dev and node tests working.
 */

describe('claudeCheck outside Tauri', () => {
  it('degrades to "not installed" instead of throwing', async () => {
    await expect(claudeCheck()).resolves.toEqual({
      installed: false,
      version: null,
      path: null,
    });
  });

  it('cached variant returns the same shape (with and without force)', async () => {
    await expect(claudeCheckCached()).resolves.toEqual({
      installed: false,
      version: null,
      path: null,
    });
    await expect(claudeCheckCached({ force: true })).resolves.toEqual({
      installed: false,
      version: null,
      path: null,
    });
  });
});

describe('claudeGenerate outside Tauri', () => {
  it('fails cleanly (no CLI in browser dev / node tests)', async () => {
    await expect(
      claudeGenerate({
        system: 'sys',
        user: 'hi',
        model: 'opus',
        workspaceDir: '/tmp',
        maxTurns: 10,
      }),
    ).rejects.toThrow('assistant unavailable outside Tauri');
  });
});

describe('claude error contract', () => {
  it('exposes the marker the Rust side embeds into auth error strings', () => {
    expect(CLAUDE_ERROR_MARKER).toBe('claude-error');
  });
});

describe('catalog → CLI wiring', () => {
  it('every claude entry resolves via modelById and carries a --model value', () => {
    const claude = MODEL_CATALOG.filter((m) => m.provider === 'claude');
    expect(claude).toHaveLength(4);
    for (const m of claude) {
      const resolved = modelById(m.id);
      expect(resolved?.cliModel, m.id).toBeTruthy();
      // The CLI flag values are short aliases, never the catalog id.
      expect(resolved?.cliModel, m.id).not.toBe(m.id);
    }
  });
});
