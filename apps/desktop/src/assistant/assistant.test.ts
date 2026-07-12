import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MODEL_CATALOG, rateModels, type RatedModel } from './models';
import { buildCommandCatalog, type CatalogSource } from './catalog';
import { buildSystemPrompt } from './prompt';
import { MEMORY_MAX_LINES, mergeMemoryLines, parseProposals } from './proposals';

function byId(rated: RatedModel[], id: string): RatedModel {
  const found = rated.find((r) => r.model.id === id);
  if (!found) throw new Error(`model ${id} missing`);
  return found;
}

describe('rateModels', () => {
  it('rates everything great on a 16GB Apple Silicon machine and recommends 8B', () => {
    const rated = rateModels({ totalRamMb: 16_384, appleSilicon: true });
    for (const r of rated) expect(r.rating).toBe('great');
    expect(byId(rated, 'qwen3-8b').recommended).toBe(true);
  });

  it('handles an 8GB Apple Silicon machine (4B ok, 8B too big, 1.7B recommended)', () => {
    const rated = rateModels({ totalRamMb: 8192, appleSilicon: true });
    expect(byId(rated, 'qwen3-0.6b').rating).toBe('great');
    expect(byId(rated, 'qwen3-1.7b').rating).toBe('great');
    expect(byId(rated, 'qwen3-4b').rating).toBe('ok');
    expect(byId(rated, 'qwen3-8b').rating).toBe('tooBig');
    expect(byId(rated, 'qwen3-8b').speed).toBe('na');
    expect(byId(rated, 'qwen3-1.7b').recommended).toBe(true);
  });

  it('rates x86 one step worse and caps 8B at slow', () => {
    const rated = rateModels({ totalRamMb: 32_768, appleSilicon: false });
    expect(byId(rated, 'qwen3-0.6b').rating).toBe('ok');
    expect(byId(rated, 'qwen3-4b').rating).toBe('ok');
    expect(byId(rated, 'qwen3-8b').rating).toBe('slow');
    // no 'great' available → best 'ok' wins
    expect(byId(rated, 'qwen3-4b').recommended).toBe(true);
  });

  it('marks models above the RAM budget as too big on x86', () => {
    const rated = rateModels({ totalRamMb: 8192, appleSilicon: false });
    expect(byId(rated, 'qwen3-4b').rating).toBe('tooBig'); // 6500 > 8192*0.7
    expect(byId(rated, 'qwen3-8b').rating).toBe('tooBig');
    expect(byId(rated, 'qwen3-1.7b').recommended).toBe(true);
  });

  it('marks exactly one model as recommended', () => {
    for (const hw of [
      { totalRamMb: 4096, appleSilicon: false },
      { totalRamMb: 8192, appleSilicon: true },
      { totalRamMb: 65_536, appleSilicon: true },
    ]) {
      expect(rateModels(hw).filter((r) => r.recommended)).toHaveLength(1);
    }
  });
});

describe('parseProposals', () => {
  const has = (id: string) => id === 'todo.create' || id === 'calendar.addEvent';

  it('accepts a valid response', () => {
    const raw = JSON.stringify({
      reply: 'Alles klar!',
      proposals: [
        { command: 'todo.create', params: { title: 'Milch kaufen' }, summary: 'Erstellt ein To-do.' },
      ],
      memory: ['kauft freitags ein'],
    });
    const parsed = parseProposals(raw, has);
    expect(parsed.parseError).toBe(false);
    expect(parsed.reply).toBe('Alles klar!');
    expect(parsed.proposals).toHaveLength(1);
    expect(parsed.proposals[0]?.params).toEqual({ title: 'Milch kaufen' });
    expect(parsed.memory).toEqual(['kauft freitags ein']);
  });

  it('strips markdown fences and surrounding chatter', () => {
    const raw =
      '```json\n{"reply":"ok","proposals":[{"command":"todo.create","params":{},"summary":"s"}],"memory":[]}\n```';
    const parsed = parseProposals(raw, has);
    expect(parsed.parseError).toBe(false);
    expect(parsed.proposals).toHaveLength(1);
  });

  it('flags garbage with parseError and returns nothing', () => {
    const parsed = parseProposals('Sorry, I cannot help with that.', has);
    expect(parsed.parseError).toBe(true);
    expect(parsed.proposals).toEqual([]);
    expect(parsed.memory).toEqual([]);
  });

  it('filters proposals with unknown commands without flagging an error', () => {
    const raw = JSON.stringify({
      reply: 'ok',
      proposals: [
        { command: 'system.wipeEverything', params: {}, summary: 'evil' },
        { command: 'todo.create', params: { title: 'x' }, summary: 'fine' },
      ],
      memory: [],
    });
    const parsed = parseProposals(raw, has);
    expect(parsed.parseError).toBe(false);
    expect(parsed.proposals).toHaveLength(1);
    expect(parsed.proposals[0]?.command).toBe('todo.create');
  });

  it('survives hostile shapes (non-array proposals, non-string memory)', () => {
    const parsed = parseProposals(
      '{"reply":42,"proposals":"nope","memory":[{"a":1},null,"valid"]}',
      has,
    );
    expect(parsed.parseError).toBe(false);
    expect(parsed.reply).toBe('');
    expect(parsed.proposals).toEqual([]);
    expect(parsed.memory).toEqual(['valid']);
  });
});

describe('buildSystemPrompt', () => {
  it('contains every section, the catalog and the injected date', () => {
    const specs: CatalogSource[] = [
      {
        id: 'todo.create',
        titleKey: 'todo.create.title',
        params: z.object({ title: z.string(), due: z.string().optional() }) as z.ZodType,
      },
      {
        id: 'secret.hidden',
        titleKey: 'secret.title',
        params: z.object({}) as z.ZodType,
        palette: false,
      },
    ];
    const catalog = buildCommandCatalog(specs, (key) => `T(${key})`);
    const prompt = buildSystemPrompt({
      instructions: 'INSTRUCTIONS-BODY',
      personality: 'PERSONALITY-BODY',
      memory: 'MEMORY-BODY',
      catalog,
      language: 'de',
      now: new Date(2026, 6, 12, 9, 30),
    });

    for (const heading of [
      '## Anweisung',
      '## Persönlichkeit',
      '## Gedächtnis',
      '## Kontext',
      '## Verfügbare Befehle',
      '## Ausgabeformat',
    ]) {
      expect(prompt).toContain(heading);
    }
    expect(prompt).toContain('INSTRUCTIONS-BODY');
    expect(prompt).toContain('PERSONALITY-BODY');
    expect(prompt).toContain('MEMORY-BODY');
    expect(prompt).toContain('todo.create');
    expect(prompt).toContain('T(todo.create.title)');
    expect(prompt).toContain('title: string (required)');
    expect(prompt).toContain('due: string (optional)');
    expect(prompt).not.toContain('secret.hidden'); // palette:false stays out
    expect(prompt).toContain('2026-07-12 09:30');
    expect(prompt).toContain('"reply"');
    expect(prompt).toContain('"proposals"');
    expect(prompt).toContain('"memory"');
  });
});

describe('mergeMemoryLines', () => {
  it('appends dated entries', () => {
    const merged = mergeMemoryLines('', ['mag Kaffee'], '2026-07-12');
    expect(merged).toBe('- [2026-07-12] mag Kaffee\n');
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

describe('model catalog', () => {
  it('ships exactly the four verified Apache-2.0 models', () => {
    expect(MODEL_CATALOG.map((m) => m.id)).toEqual([
      'qwen3-0.6b',
      'qwen3-1.7b',
      'qwen3-4b',
      'qwen3-8b',
    ]);
    for (const m of MODEL_CATALOG) {
      expect(m.url.startsWith('https://huggingface.co/')).toBe(true);
    }
  });
});
