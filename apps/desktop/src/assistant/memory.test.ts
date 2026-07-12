import { describe, expect, it, vi } from 'vitest';
import { createMemoryBackend } from '@cardo/core';
import { createMemoryDocStore } from './api';
import { createProfilesStore, SHARED_MEMORY_ID } from './profiles';
import {
  appendMemory,
  forgetLines,
  MEMORY_MAX_LINES,
  mergeMemoryLines,
  readMemory,
  removeMemoryLines,
} from './memory';

describe('mergeMemoryLines (pure)', () => {
  it('appends dated entries', () => {
    expect(mergeMemoryLines('', ['mag Kaffee'], '2026-07-12')).toBe('- [2026-07-12] mag Kaffee\n');
  });

  it('dedupes entries that already exist (even with an older date)', () => {
    const current = '- [2026-01-01] mag Kaffee\n';
    const merged = mergeMemoryLines(current, ['mag Kaffee', 'mag Kaffee', 'trinkt Tee'], '2026-07-12');
    expect(merged.split('\n').filter(Boolean)).toEqual([
      '- [2026-01-01] mag Kaffee',
      '- [2026-07-12] trinkt Tee',
    ]);
  });

  it('caps at the max line count, dropping the oldest lines', () => {
    const current = Array.from({ length: 130 }, (_, i) => `- [2026-01-01] fact ${i}`).join('\n');
    const merged = mergeMemoryLines(current, ['brandneu'], '2026-07-12');
    const lines = merged.split('\n').filter(Boolean);
    expect(lines).toHaveLength(MEMORY_MAX_LINES);
    expect(lines[lines.length - 1]).toBe('- [2026-07-12] brandneu');
    expect(lines[0]).toBe(`- [2026-01-01] fact ${130 - (MEMORY_MAX_LINES - 1)}`);
    expect(merged).not.toContain('fact 0\n');
  });
});

describe('removeMemoryLines (pure)', () => {
  const current = '- [2026-01-01] mag Kaffee\n- [2026-02-02] hasst Meetings\n';

  it('removes exact lines including the date prefix', () => {
    expect(removeMemoryLines(current, ['- [2026-01-01] mag Kaffee'])).toBe(
      '- [2026-02-02] hasst Meetings\n',
    );
  });

  it('is tolerant of a missing prefix on the forget side', () => {
    expect(removeMemoryLines(current, ['mag Kaffee'])).toBe('- [2026-02-02] hasst Meetings\n');
  });

  it('is tolerant of a mismatched date on the forget side', () => {
    expect(removeMemoryLines(current, ['- [2030-12-31] mag Kaffee'])).toBe(
      '- [2026-02-02] hasst Meetings\n',
    );
  });

  it('leaves non-matching lines alone and empties cleanly', () => {
    expect(removeMemoryLines(current, ['mag Tee'])).toBe(current);
    expect(removeMemoryLines(current, ['mag Kaffee', 'hasst Meetings'])).toBe('');
  });
});

describe('doc-backed memory', () => {
  it('appendMemory + readMemory round-trip with dedupe and date prefix', async () => {
    const docs = createMemoryDocStore();
    const now = new Date(2026, 6, 12);
    await appendMemory('m1', ['mag Kaffee'], now, docs);
    await appendMemory('m1', ['mag Kaffee', 'trinkt Tee'], now, docs);
    expect(await readMemory('m1', docs)).toBe(
      '- [2026-07-12] mag Kaffee\n- [2026-07-12] trinkt Tee\n',
    );
  });

  it('two profiles sharing a memory id write into the same doc', async () => {
    const docs = createMemoryDocStore();
    const store = createProfilesStore({
      backend: createMemoryBackend(),
      docs,
      migrateNative: vi.fn(async () => false),
    });
    await store.init();
    const a = await store.createProfile({
      name: 'A',
      emoji: '🅰️',
      color: 'accent-1',
      modelId: 'qwen3-4b',
      memoryChoice: { share: SHARED_MEMORY_ID },
      toolScope: null,
      personality: '',
      instructions: '',
    });
    const b = await store.createProfile({
      name: 'B',
      emoji: '🅱️',
      color: 'accent-2',
      modelId: 'qwen3-8b',
      memoryChoice: { share: SHARED_MEMORY_ID },
      toolScope: null,
      personality: '',
      instructions: '',
    });

    const now = new Date(2026, 6, 12);
    const memA = store.resolveMemoryId({ type: 'profile', id: a.id });
    const memB = store.resolveMemoryId({ type: 'profile', id: b.id });
    expect(memA).toBe(memB);

    await appendMemory(memA, ['Fakt von A'], now, docs);
    await appendMemory(memB, ['Fakt von B', 'Fakt von A'], now, docs); // dedupe across writers
    expect(await readMemory(memB, docs)).toBe(
      '- [2026-07-12] Fakt von A\n- [2026-07-12] Fakt von B\n',
    );
  });

  it('forgetLines removes exact lines with prefix tolerance', async () => {
    const docs = createMemoryDocStore();
    const now = new Date(2026, 6, 12);
    await appendMemory('m2', ['mag Kaffee', 'hasst Meetings'], now, docs);
    await forgetLines('m2', ['mag Kaffee'], docs);
    expect(await readMemory('m2', docs)).toBe('- [2026-07-12] hasst Meetings\n');
    await forgetLines('m2', ['- [2026-07-12] hasst Meetings'], docs);
    expect(await readMemory('m2', docs)).toBe('');
  });

  it('caps the doc at MEMORY_MAX_LINES', async () => {
    const docs = createMemoryDocStore();
    const now = new Date(2026, 6, 12);
    const entries = Array.from({ length: 150 }, (_, i) => `fact ${i}`);
    await appendMemory('m3', entries, now, docs);
    const lines = (await readMemory('m3', docs)).split('\n').filter(Boolean);
    expect(lines).toHaveLength(MEMORY_MAX_LINES);
    expect(lines[0]).toBe('- [2026-07-12] fact 30');
    expect(lines[lines.length - 1]).toBe('- [2026-07-12] fact 149');
  });
});
