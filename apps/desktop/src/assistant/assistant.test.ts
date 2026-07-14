import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildCommandCatalog, filterCatalogByScope, type CatalogSource } from './catalog';
import { buildSystemPrompt } from './prompt';

describe('buildSystemPrompt', () => {
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

  it('contains every section, the catalog and the injected date', () => {
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
    // Without delegation there is no team/delegate/forget contract.
    expect(prompt).not.toContain('## Team');
    expect(prompt).not.toContain('"delegate"');
    expect(prompt).not.toContain('"forget"');
    expect(prompt).not.toContain('## Kompetenzen');
  });

  it('uses currentDateIso verbatim when provided', () => {
    const prompt = buildSystemPrompt({
      instructions: '',
      personality: '',
      memory: '',
      catalog: [],
      language: 'en',
      currentDateIso: '2030-01-02 08:15',
      now: new Date(2026, 6, 12, 9, 30),
    });
    expect(prompt).toContain('2030-01-02 08:15');
    expect(prompt).not.toContain('2026-07-12 09:30');
  });

  it('adds the competences section only when non-empty', () => {
    const withFile = buildSystemPrompt({
      instructions: '',
      personality: '',
      memory: '',
      competencesFile: 'KOMPETENZEN-BODY',
      catalog: [],
      language: 'de',
      now: new Date(2026, 6, 12),
    });
    expect(withFile).toContain('## Kompetenzen');
    expect(withFile).toContain('KOMPETENZEN-BODY');

    const without = buildSystemPrompt({
      instructions: '',
      personality: '',
      memory: '',
      competencesFile: '   ',
      catalog: [],
      language: 'de',
      now: new Date(2026, 6, 12),
    });
    expect(without).not.toContain('## Kompetenzen');
  });

  it('adds team section and delegate/forget contract when delegation is enabled', () => {
    const prompt = buildSystemPrompt({
      instructions: '',
      personality: '',
      memory: '',
      catalog,
      language: 'de',
      now: new Date(2026, 6, 12),
      delegation: {
        enabled: true,
        ownProfileId: 'p-self',
        others: [
          { id: 'p-writer', name: 'Texterin', competences: 'Schreibt gute Texte' },
          { id: 'p-coder', name: 'Coder', competences: '' },
        ],
      },
    });
    expect(prompt).toContain('## Team');
    expect(prompt).toContain('p-self');
    expect(prompt).toContain('p-writer');
    expect(prompt).toContain('Texterin');
    expect(prompt).toContain('Schreibt gute Texte');
    expect(prompt).toContain('p-coder');
    expect(prompt).toContain('(keine Angaben)');
    expect(prompt).toContain('"delegate"');
    expect(prompt).toContain('"forget"');
  });

  it('does not add the contract when delegation is disabled', () => {
    const prompt = buildSystemPrompt({
      instructions: '',
      personality: '',
      memory: '',
      catalog,
      language: 'de',
      now: new Date(2026, 6, 12),
      delegation: { enabled: false, ownProfileId: 'p-self', others: [] },
    });
    expect(prompt).not.toContain('## Team');
    expect(prompt).not.toContain('"delegate"');
  });

  it('agentWorkspace adds the Cardo context, hard limits and direct-file rule', () => {
    const on = buildSystemPrompt({
      instructions: '',
      personality: '',
      memory: '',
      catalog,
      language: 'de',
      now: new Date(2026, 6, 12),
      agentWorkspace: true,
    });
    expect(on).toContain('## Cardo & dein Arbeitsbereich');
    // States the hard limit and that it directly does file work.
    expect(on).toContain('keine Rechte');
    expect(on).toContain('DIREKT');
    expect(on).toContain('Große Aufträge');
    // The direct-file rule replaces the workspace.*-proposal rule.
    expect(on).not.toContain('nutze die workspace.*-Befehle als Vorschläge');

    // Default (local models) keeps the proposal-card rule and no Cardo section.
    const off = buildSystemPrompt({
      instructions: '',
      personality: '',
      memory: '',
      catalog,
      language: 'de',
      now: new Date(2026, 6, 12),
    });
    expect(off).not.toContain('## Cardo & dein Arbeitsbereich');
    expect(off).toContain('nutze die workspace.*-Befehle als Vorschläge');
  });

  it('renders live capabilities (themes + design) when provided', () => {
    const prompt = buildSystemPrompt({
      instructions: '',
      personality: '',
      memory: '',
      catalog,
      language: 'de',
      now: new Date(2026, 6, 12),
      capabilities: {
        themes: ['Nord (dunkel)', 'GitHub Light (hell)'],
        design: ['Schriftart (system, serif), Dichte (normal).'],
      },
    });
    expect(prompt).toContain('## Cardo aktuell');
    expect(prompt).toContain('Nord (dunkel)');
    expect(prompt).toContain('GitHub Light (hell)');
    expect(prompt).toContain('Schriftart (system, serif)');

    // No capabilities → no section at all.
    const bare = buildSystemPrompt({
      instructions: '',
      personality: '',
      memory: '',
      catalog,
      language: 'de',
      now: new Date(2026, 6, 12),
    });
    expect(bare).not.toContain('## Cardo aktuell');
  });
});

describe('filterCatalogByScope', () => {
  const specs: CatalogSource[] = [
    { id: 'todo.create', titleKey: 'k', params: z.object({}) as z.ZodType },
    { id: 'calendar.addEvent', titleKey: 'k', params: z.object({}) as z.ZodType },
    { id: 'notes.append', titleKey: 'k', params: z.object({}) as z.ZodType },
  ];
  const catalog = buildCommandCatalog(specs, (k) => k);

  it('null scope keeps everything', () => {
    expect(filterCatalogByScope(catalog, null)).toHaveLength(3);
  });

  it('filters by tool prefix and full command id', () => {
    const filtered = filterCatalogByScope(catalog, ['todo', 'calendar.addEvent']);
    expect(filtered.map((e) => e.id)).toEqual(['todo.create', 'calendar.addEvent']);
  });

  it('empty scope blocks everything', () => {
    expect(filterCatalogByScope(catalog, [])).toEqual([]);
  });
});
