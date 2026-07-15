import { describe, expect, it } from 'vitest';
import {
  buildNoteMarkdown,
  buildReadingContext,
  filterByStatus,
  makeItem,
  slugify,
  sortItems,
  validateUrl,
  type ReadingItem,
  type ReadingStatus,
} from './logic';

function item(
  title: string,
  status: ReadingStatus,
  createdAt: string,
  extra: Partial<ReadingItem> = {},
): ReadingItem {
  return {
    id: `item:${title}`,
    type: 'item',
    title,
    status,
    notes: '',
    createdAt,
    ...extra,
  };
}

describe('makeItem', () => {
  it('creates a queued item with trimmed title and empty notes', () => {
    const created = makeItem({ title: '  Deep Work  ' }, new Date('2026-07-15T10:00:00Z'));
    expect(created.title).toBe('Deep Work');
    expect(created.status).toBe('queued');
    expect(created.notes).toBe('');
    expect(created.type).toBe('item');
    expect(created.id.startsWith('item:')).toBe(true);
    expect(created.createdAt).toBe('2026-07-15T10:00:00.000Z');
    expect(created.url).toBeUndefined();
  });

  it('keeps a trimmed url and drops a blank one', () => {
    expect(makeItem({ title: 'A', url: ' https://example.org ' }).url).toBe('https://example.org');
    expect(makeItem({ title: 'A', url: '   ' }).url).toBeUndefined();
  });
});

describe('validateUrl', () => {
  it('accepts http and https', () => {
    expect(validateUrl('https://example.org/article?id=1')).toBe(true);
    expect(validateUrl('http://example.org')).toBe(true);
    expect(validateUrl('  https://example.org  ')).toBe(true);
    expect(validateUrl('HTTPS://EXAMPLE.ORG')).toBe(true);
  });

  it('rejects other schemes, scheme-less and garbage input', () => {
    expect(validateUrl('javascript:alert(1)')).toBe(false);
    expect(validateUrl('data:text/html,x')).toBe(false);
    expect(validateUrl('ftp://example.org')).toBe(false);
    expect(validateUrl('example.org')).toBe(false);
    expect(validateUrl('')).toBe(false);
    expect(validateUrl('https://')).toBe(false);
  });
});

describe('sortItems', () => {
  it('orders reading → queued → done, FIFO inside a status', () => {
    const items = [
      item('done-new', 'done', '2026-01-04'),
      item('queued-old', 'queued', '2026-01-01'),
      item('reading', 'reading', '2026-01-03'),
      item('queued-new', 'queued', '2026-01-02'),
    ];
    expect(sortItems(items).map((i) => i.title)).toEqual([
      'reading',
      'queued-old',
      'queued-new',
      'done-new',
    ]);
  });

  it('does not mutate the input array', () => {
    const items = [item('b', 'done', '2026-01-01'), item('a', 'reading', '2026-01-01')];
    sortItems(items);
    expect(items[0]?.title).toBe('b');
  });
});

describe('filterByStatus', () => {
  it('returns only items of the requested status', () => {
    const items = [
      item('a', 'queued', '2026-01-01'),
      item('b', 'reading', '2026-01-01'),
      item('c', 'queued', '2026-01-02'),
    ];
    expect(filterByStatus(items, 'queued').map((i) => i.title)).toEqual(['a', 'c']);
    expect(filterByStatus(items, 'done')).toEqual([]);
  });
});

describe('slugify', () => {
  it('lowercases and dashes non-alphanumerics', () => {
    expect(slugify('Deep Work: Rules!')).toBe('deep-work-rules');
  });

  it('transliterates German umlauts and ß', () => {
    expect(slugify('Über größere Bücher')).toBe('ueber-groessere-buecher');
  });

  it('strips other diacritics', () => {
    expect(slugify('Café Résumé')).toBe('cafe-resume');
  });

  it('never returns an empty slug', () => {
    expect(slugify('')).toBe('item');
    expect(slugify('!!!')).toBe('item');
  });

  it('caps the length without a trailing dash', () => {
    const slug = slugify(`${'a'.repeat(59)} b`);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('buildNoteMarkdown', () => {
  it('includes title, url and notes as blocks', () => {
    const md = buildNoteMarkdown({
      title: 'Deep Work',
      url: 'https://example.org',
      notes: 'Chapter 2 is key.\nRe-read it.',
    });
    expect(md).toBe('# Deep Work\n\n<https://example.org>\n\nChapter 2 is key.\nRe-read it.\n');
  });

  it('omits missing url and empty notes', () => {
    expect(buildNoteMarkdown({ title: 'Deep Work', notes: '  ' })).toBe('# Deep Work\n');
  });

  it('flattens newlines in the title', () => {
    expect(buildNoteMarkdown({ title: 'A\nB', notes: '' })).toBe('# A B\n');
  });
});

describe('buildReadingContext', () => {
  it('reports an empty list in both languages', () => {
    expect(buildReadingContext([], 'en')).toBe('The reading list is empty.');
    expect(buildReadingContext([], 'de')).toBe('Die Leseliste ist leer.');
  });

  it('groups titles by status in status order', () => {
    const items = [
      item('Queued Book', 'queued', '2026-01-01'),
      item('Current Article', 'reading', '2026-01-02'),
      item('Finished Book', 'done', '2026-01-03'),
    ];
    const text = buildReadingContext(items, 'en');
    expect(text).toBe(
      'Currently reading: «Current Article». Queued: «Queued Book». Done: «Finished Book».',
    );
  });

  it('uses German labels for de', () => {
    const text = buildReadingContext([item('Buch', 'queued', '2026-01-01')], 'de');
    expect(text).toBe('Vorgemerkt: «Buch».');
  });

  it('caps each status group at 10 titles', () => {
    const items = Array.from({ length: 15 }, (_, i) =>
      item(`t${i}`, 'queued', `2026-01-${String(i + 1).padStart(2, '0')}`),
    );
    const text = buildReadingContext(items, 'en');
    expect(text).toContain('«t9»');
    expect(text).not.toContain('«t10»');
  });
});
