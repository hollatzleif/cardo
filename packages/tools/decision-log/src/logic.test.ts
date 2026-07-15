import { describe, expect, it } from 'vitest';
import {
  buildDecisionContext,
  decisionFileName,
  isDecisionFileName,
  parseDecision,
  serializeDecision,
  slugify,
  sortByDateDesc,
  todayIso,
  type Decision,
} from './logic';

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    title: 'Use SQLite',
    date: '2026-07-15',
    context: 'We need local persistence.',
    options: '- SQLite\n- JSON files',
    decision: 'SQLite via the host storage layer.',
    rationale: 'Queryable and battle-tested.',
    ...overrides,
  };
}

describe('serializeDecision / parseDecision round-trip', () => {
  it('round-trips a full decision (German headings)', () => {
    const d = decision();
    const md = serializeDecision(d, 'de');
    expect(md).toContain('# Use SQLite');
    expect(md).toContain('*2026-07-15*');
    expect(md).toContain('## Kontext');
    expect(md).toContain('## Optionen');
    expect(md).toContain('## Entscheidung');
    expect(md).toContain('## Begründung');
    expect(parseDecision(md)).toEqual(d);
  });

  it('round-trips with English headings', () => {
    const d = decision();
    const md = serializeDecision(d, 'en');
    expect(md).toContain('## Decision');
    expect(md).toContain('## Rationale');
    expect(parseDecision(md)).toEqual(d);
  });

  it('unknown languages fall back to English headings', () => {
    expect(serializeDecision(decision(), 'fr')).toContain('## Context');
  });

  it('round-trips special characters and umlauts', () => {
    const d = decision({
      title: 'Ärger & Größe: "Maße" <prüfen>?',
      decision: 'Wir nehmen die größere Variante – natürlich!',
      rationale: 'Weil *Sterne* und `Backticks` & <tags> erhalten bleiben müssen.',
    });
    expect(parseDecision(serializeDecision(d, 'de'))).toEqual(d);
  });

  it('round-trips a multiline rationale with blank lines and lists', () => {
    const d = decision({
      rationale: 'First paragraph.\n\nSecond paragraph:\n- point a\n- point b\n\n1. numbered',
    });
    expect(parseDecision(serializeDecision(d, 'de'))).toEqual(d);
    expect(parseDecision(serializeDecision(d, 'en'))).toEqual(d);
  });

  it('omits empty sections but keeps them as empty strings after parsing', () => {
    const d = decision({ context: '', options: '', rationale: '' });
    const md = serializeDecision(d, 'de');
    expect(md).not.toContain('## Kontext');
    expect(md).not.toContain('## Optionen');
    expect(md).not.toContain('## Begründung');
    expect(parseDecision(md)).toEqual(d);
  });

  it('flattens newlines in the title', () => {
    const md = serializeDecision(decision({ title: 'One\nTwo' }), 'en');
    expect(parseDecision(md)?.title).toBe('One Two');
  });

  it('parses mixed-language and differently-cased headings', () => {
    const md = '# T\n\n*2026-01-01*\n\n## KONTEXT\n\nctx\n\n## Rationale\n\nwhy\n';
    expect(parseDecision(md)).toEqual({
      title: 'T',
      date: '2026-01-01',
      context: 'ctx',
      options: '',
      decision: '',
      rationale: 'why',
    });
  });

  it('ignores unknown sections instead of leaking them into fields', () => {
    const md = '# T\n\n*2026-01-01*\n\n## Weird\n\nnoise\n\n## Decision\n\nyes\n';
    const parsed = parseDecision(md);
    expect(parsed?.decision).toBe('yes');
    expect(parsed?.context).toBe('');
  });

  it('returns null for markdown without a title', () => {
    expect(parseDecision('just text\n\n## Decision\n\nx')).toBeNull();
    expect(parseDecision('')).toBeNull();
  });
});

describe('slugify / decisionFileName', () => {
  it('transliterates umlauts and dashes specials', () => {
    expect(slugify('Größere Änderung: Ja!')).toBe('groessere-aenderung-ja');
  });

  it('never returns an empty slug', () => {
    expect(slugify('')).toBe('decision');
    expect(slugify('???')).toBe('decision');
  });

  it('builds the canonical file name', () => {
    expect(decisionFileName('2026-07-15', 'Use SQLite')).toBe('decision-2026-07-15-use-sqlite.md');
  });

  it('recognizes decision file names', () => {
    expect(isDecisionFileName('decision-2026-07-15-use-sqlite.md')).toBe(true);
    expect(isDecisionFileName('decision-2026-07-15-use-sqlite.txt')).toBe(false);
    expect(isDecisionFileName('reading-use-sqlite.md')).toBe(false);
    expect(isDecisionFileName('decision-x.md')).toBe(false);
  });
});

describe('todayIso', () => {
  it('formats the local date with padding', () => {
    expect(todayIso(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('sortByDateDesc', () => {
  it('sorts newest first with a stable title tie-break', () => {
    const sorted = sortByDateDesc([
      { title: 'b', date: '2026-01-01' },
      { title: 'a', date: '2026-01-01' },
      { title: 'c', date: '2026-02-01' },
    ]);
    expect(sorted.map((d) => d.title)).toEqual(['c', 'a', 'b']);
  });
});

describe('buildDecisionContext', () => {
  it('reports the empty state in both languages', () => {
    expect(buildDecisionContext([], 'en')).toBe('No decisions logged yet.');
    expect(buildDecisionContext([], 'de')).toBe('Noch keine Entscheidungen dokumentiert.');
  });

  it('lists the last 5 decisions newest first with dates', () => {
    const decisions = Array.from({ length: 7 }, (_, i) => ({
      title: `d${i}`,
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    }));
    const text = buildDecisionContext(decisions, 'en');
    expect(text.startsWith('Latest decisions: «d6» (2026-01-07)')).toBe(true);
    expect(text).toContain('«d2»');
    expect(text).not.toContain('«d1»');
    expect(text).not.toContain('«d0»');
  });

  it('uses the German label for de', () => {
    expect(buildDecisionContext([{ title: 'X', date: '2026-01-01' }], 'de')).toBe(
      'Letzte Entscheidungen: «X» (2026-01-01).',
    );
  });
});
