import { describe, expect, it } from 'vitest';
import {
  addSnippetParamsSchema,
  allTags,
  buildSnippetsContext,
  filterSnippets,
  highlightLines,
  LANGUAGE_IDS,
  makeSnippet,
  normalizeLanguage,
  splitTags,
  type SnippetDoc,
  type Span,
} from './logic';

function snippet(partial: Partial<SnippetDoc>): SnippetDoc {
  return {
    id: 'snippet:test',
    type: 'snippet',
    title: 'Test snippet',
    language: 'js',
    body: 'const x = 1;',
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

const joinLine = (spans: Span[]) => spans.map((s) => s.text).join('');
const kindsOf = (spans: Span[]) => spans.map((s) => s.kind);
const textOf = (spans: Span[], kind: string) =>
  spans
    .filter((s) => s.kind === kind)
    .map((s) => s.text)
    .join('');

describe('normalizeLanguage', () => {
  it('knows the 8 canonical languages', () => {
    expect(LANGUAGE_IDS).toEqual(['js', 'ts', 'python', 'rust', 'css', 'html', 'json', 'shell']);
    for (const id of LANGUAGE_IDS) expect(normalizeLanguage(id)).toBe(id);
  });

  it('resolves aliases and rejects unknowns', () => {
    expect(normalizeLanguage('JavaScript')).toBe('js');
    expect(normalizeLanguage('TypeScript')).toBe('ts');
    expect(normalizeLanguage('py')).toBe('python');
    expect(normalizeLanguage('bash')).toBe('shell');
    expect(normalizeLanguage('rs')).toBe('rust');
    expect(normalizeLanguage('cobol')).toBeNull();
  });
});

describe('highlightLines – basics', () => {
  it('marks keywords, leaves other code plain', () => {
    const [line] = highlightLines('const x = require(y);', 'js');
    expect(line).toBeDefined();
    if (!line) return;
    expect(textOf(line, 'keyword')).toBe('const');
    expect(joinLine(line)).toBe('const x = require(y);');
  });

  it('does NOT mark keyword substrings inside longer words', () => {
    const [line] = highlightLines('constant iffy = 1', 'js');
    expect(line).toBeDefined();
    if (!line) return;
    expect(textOf(line, 'keyword')).toBe('');
  });

  it('unknown language falls back to a single plain span per line', () => {
    const lines = highlightLines('const x = "hi" // no\nsecond', 'cobol');
    expect(lines).toEqual([
      [{ text: 'const x = "hi" // no', kind: 'code' }],
      [{ text: 'second', kind: 'code' }],
    ]);
  });

  it('empty lines yield empty span arrays', () => {
    expect(highlightLines('a\n\nb', 'js')).toHaveLength(3);
    expect(highlightLines('a\n\nb', 'js')[1]).toEqual([]);
  });

  it('invariant: joined span texts reproduce every line exactly', () => {
    const samples: Array<[string, string]> = [
      ['const s = "a // b" + `t${x}`; // tail', 'js'],
      ['def f(x):  # comment with "quote"', 'python'],
      ['let s = "\\"escaped\\""; /* block */ fn main() {}', 'rust'],
      ['.cls { color: red; } /* note */', 'css'],
      ['<div class="x"><!-- hidden --></div>', 'html'],
      ['{"key": "value", "on": true}', 'json'],
      ['echo "hello # not comment" # real comment', 'shell'],
      ['plain text without any tokens', 'ts'],
    ];
    for (const [code, lang] of samples) {
      for (const line of highlightLines(code, lang)) {
        expect(joinLine(line)).toBe(code);
      }
    }
  });
});

describe('highlightLines – strings vs comments', () => {
  it('// inside a js string stays a string', () => {
    const [line] = highlightLines('const url = "http://example.com"; // real', 'js');
    expect(line).toBeDefined();
    if (!line) return;
    expect(textOf(line, 'string')).toBe('"http://example.com"');
    expect(textOf(line, 'comment')).toBe('// real');
  });

  it('# inside a shell string stays a string', () => {
    const [line] = highlightLines('echo "a # b" # c', 'shell');
    expect(line).toBeDefined();
    if (!line) return;
    expect(textOf(line, 'string')).toBe('"a # b"');
    expect(textOf(line, 'comment')).toBe('# c');
  });

  it('python # comments highlight, full-line and trailing', () => {
    const lines = highlightLines('# top\nx = 1  # tail', 'python');
    expect(lines[0]).toEqual([{ text: '# top', kind: 'comment' }]);
    const second = lines[1];
    expect(second).toBeDefined();
    if (!second) return;
    expect(textOf(second, 'comment')).toBe('# tail');
  });

  it('escaped quotes do not terminate the string', () => {
    const [line] = highlightLines('a = "he said \\"hi\\"" + b', 'js');
    expect(line).toBeDefined();
    if (!line) return;
    expect(textOf(line, 'string')).toBe('"he said \\"hi\\""');
  });

  it('unterminated strings run to end of line without throwing', () => {
    const [line] = highlightLines('const s = "open', 'js');
    expect(line).toBeDefined();
    if (!line) return;
    expect(textOf(line, 'string')).toBe('"open');
    expect(joinLine(line)).toBe('const s = "open');
  });

  it('keywords inside strings and comments are NOT keyword spans', () => {
    const [line] = highlightLines('"return" // return', 'js');
    expect(line).toBeDefined();
    if (!line) return;
    expect(textOf(line, 'keyword')).toBe('');
  });
});

describe('highlightLines – block comments', () => {
  it('single-line block comments close on the same line', () => {
    const [line] = highlightLines('let a = 1; /* mid */ let b;', 'js');
    expect(line).toBeDefined();
    if (!line) return;
    expect(textOf(line, 'comment')).toBe('/* mid */');
    expect(textOf(line, 'keyword')).toBe('letlet');
  });

  it('block comments carry across lines (js and css)', () => {
    for (const lang of ['js', 'css']) {
      const lines = highlightLines('before /* open\nmiddle\nend */ after', lang);
      expect(lines[1]).toEqual([{ text: 'middle', kind: 'comment' }]);
      const last = lines[2];
      expect(last).toBeDefined();
      if (!last) continue;
      expect(textOf(last, 'comment')).toBe('end */');
      expect(joinLine(last)).toBe('end */ after');
    }
  });

  it('html comments use <!-- -->', () => {
    const [line] = highlightLines('<p><!-- note --></p>', 'html');
    expect(line).toBeDefined();
    if (!line) return;
    expect(textOf(line, 'comment')).toBe('<!-- note -->');
  });

  it('json literals highlight as keywords, no comment support', () => {
    const [line] = highlightLines('{"a": true, "b": null} // not a comment', 'json');
    expect(line).toBeDefined();
    if (!line) return;
    expect(textOf(line, 'keyword')).toBe('truenull');
    expect(textOf(line, 'comment')).toBe('');
    // "a" and "b" are strings, not code.
    expect(textOf(line, 'string')).toBe('"a""b"');
  });
});

describe('filterSnippets / allTags', () => {
  const docs = [
    snippet({ id: 'snippet:a', title: 'Fetch helper', tags: ['http', 'Util'], body: 'fetch(url)' }),
    snippet({ id: 'snippet:b', title: 'Debounce', tags: ['util'], body: 'setTimeout' }),
    snippet({ id: 'snippet:c', title: 'Grid layout', language: 'css', tags: [], body: 'display: grid' }),
  ];

  it('empty query and tag pass everything', () => {
    expect(filterSnippets(docs, '')).toHaveLength(3);
    expect(filterSnippets(docs, '  ', '')).toHaveLength(3);
  });

  it('matches title, body, language and tags case-insensitively', () => {
    expect(filterSnippets(docs, 'FETCH').map((s) => s.id)).toEqual(['snippet:a']);
    expect(filterSnippets(docs, 'settimeout').map((s) => s.id)).toEqual(['snippet:b']);
    expect(filterSnippets(docs, 'css').map((s) => s.id)).toEqual(['snippet:c']);
    expect(filterSnippets(docs, 'http').map((s) => s.id)).toEqual(['snippet:a']);
  });

  it('tag filter is exact (case-insensitive) and combines with the query', () => {
    expect(filterSnippets(docs, '', 'util').map((s) => s.id)).toEqual(['snippet:a', 'snippet:b']);
    expect(filterSnippets(docs, 'debounce', 'util').map((s) => s.id)).toEqual(['snippet:b']);
    expect(filterSnippets(docs, '', 'nope')).toEqual([]);
  });

  it('allTags dedupes case-insensitively and sorts', () => {
    expect(allTags(docs)).toEqual(['http', 'Util']);
    expect(allTags([])).toEqual([]);
  });
});

describe('snippet factory & schema & context', () => {
  it('makeSnippet trims, normalizes the language and keeps tags', () => {
    const doc = makeSnippet(
      { title: '  Hi  ', language: 'JavaScript', body: 'x', tags: ['a'] },
      new Date('2026-07-15T10:00:00Z'),
    );
    expect(doc.title).toBe('Hi');
    expect(doc.language).toBe('js');
    expect(doc.tags).toEqual(['a']);
    expect(doc.id.startsWith('snippet:')).toBe(true);
    expect(doc.type).toBe('snippet');
  });

  it('unknown languages are kept lowercased (plain rendering)', () => {
    expect(makeSnippet({ title: 'x', language: ' Cobol ', body: 'y' }).language).toBe('cobol');
  });

  it('splitTags trims, dedupes and drops empties', () => {
    expect(splitTags(' a, B ,, a ')).toEqual(['a', 'B']);
    expect(splitTags(undefined)).toEqual([]);
  });

  it('addSnippetParamsSchema validates', () => {
    const valid = { title: 'T', language: 'js', body: 'x' };
    expect(addSnippetParamsSchema.safeParse(valid).success).toBe(true);
    expect(addSnippetParamsSchema.safeParse({ ...valid, tags: 'a,b' }).success).toBe(true);
    expect(addSnippetParamsSchema.safeParse({ ...valid, title: '' }).success).toBe(false);
    expect(addSnippetParamsSchema.safeParse({ ...valid, body: '' }).success).toBe(false);
    expect(addSnippetParamsSchema.safeParse({ ...valid, language: '' }).success).toBe(false);
  });

  it('buildSnippetsContext reports counts and the newest titles', () => {
    expect(buildSnippetsContext([], 'en')).toBe('No snippets saved.');
    expect(buildSnippetsContext([], 'de')).toBe('Keine Snippets gespeichert.');
    const docs = [
      snippet({ title: 'Old', createdAt: '2026-01-01T00:00:00.000Z' }),
      snippet({ title: 'New', createdAt: '2026-07-01T00:00:00.000Z' }),
      snippet({ title: 'Mid', createdAt: '2026-03-01T00:00:00.000Z' }),
      snippet({ title: 'Ancient', createdAt: '2025-01-01T00:00:00.000Z' }),
    ];
    const text = buildSnippetsContext(docs, 'en');
    expect(text).toContain('4 snippets saved');
    expect(text).toContain('«New» (js), «Mid» (js), «Old» (js)');
    expect(text).not.toContain('Ancient');
    expect(buildSnippetsContext(docs, 'de')).toContain('4 Snippets gespeichert');
  });
});
