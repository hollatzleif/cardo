import { describe, expect, it } from 'vitest';
import {
  addParagraphSchema,
  buildContext,
  makeParagraph,
  paragraphLabel,
  searchParagraphs,
  textHash,
  type ParagraphDoc,
} from './logic';

describe('makeParagraph', () => {
  it('builds an offline doc, trimming fields and hashing the text', () => {
    const p = makeParagraph({
      jurisdiction: ' DE ',
      book: ' BGB ',
      norm: ' § 242 ',
      section: ' Abs. 1 ',
      title: ' Treu und Glauben ',
      text: ' Der Schuldner ist verpflichtet… ',
      comment: ' wichtig ',
    });
    expect(p.type).toBe('paragraph');
    expect(p.mode).toBe('offline');
    expect(p.book).toBe('BGB');
    expect(p.norm).toBe('§ 242');
    expect(p.section).toBe('Abs. 1');
    expect(p.text).toBe('Der Schuldner ist verpflichtet…');
    expect(p.stand).toBe('');
    expect(p.sourceUrl).toBe('');
    expect(p.textHash).toBe(textHash('Der Schuldner ist verpflichtet…'));
  });

  it('carries online stand, source and re-fetch coordinates when provided', () => {
    const p = makeParagraph(
      { jurisdiction: 'DE', book: 'BGB', norm: '§ 1', section: '', title: '', text: 'x', comment: '' },
      new Date('2026-07-17T00:00:00Z'),
      'online',
      { stand: '2026-07-01', sourceUrl: 'https://example/§1', sourceId: 'de', bookId: 'bgb', normId: '§ 1' },
    );
    expect(p.mode).toBe('online');
    expect(p.stand).toBe('2026-07-01');
    expect(p.sourceUrl).toBe('https://example/§1');
    expect(p.sourceId).toBe('de');
    expect(p.bookId).toBe('bgb');
    expect(p.normId).toBe('§ 1');
  });

  it('an offline paragraph has empty online coordinates', () => {
    const p = makeParagraph({ jurisdiction: '', book: 'BGB', norm: '§ 1', section: '', title: '', text: 'x', comment: '' });
    expect(p.sourceId).toBe('');
    expect(p.bookId).toBe('');
    expect(p.normId).toBe('');
  });

  it('requires book and norm via the schema', () => {
    expect(addParagraphSchema.safeParse({ book: 'BGB', norm: '§ 1' }).success).toBe(true);
    expect(addParagraphSchema.safeParse({ book: '', norm: '§ 1' }).success).toBe(false);
    expect(addParagraphSchema.safeParse({ book: 'BGB', norm: '' }).success).toBe(false);
  });
});

describe('paragraphLabel', () => {
  it('joins book/norm/section, skipping empties', () => {
    expect(paragraphLabel({ book: 'BGB', norm: '§ 242', section: 'Abs. 1' })).toBe('BGB § 242 Abs. 1');
    expect(paragraphLabel({ book: 'GG', norm: 'Art. 1', section: '' })).toBe('GG Art. 1');
  });
});

describe('searchParagraphs', () => {
  const list: ParagraphDoc[] = [
    makeParagraph({ jurisdiction: 'DE', book: 'GG', norm: 'Art. 1', section: '', title: 'Menschenwürde', text: 'unantastbar', comment: '' }),
    makeParagraph({ jurisdiction: 'DE', book: 'BGB', norm: '§ 242', section: '', title: 'Treu und Glauben', text: 'Schuldner', comment: 'Generalklausel' }),
  ];

  it('sorts by label when the query is empty', () => {
    expect(searchParagraphs(list, '  ').map(paragraphLabel)).toEqual(['BGB § 242', 'GG Art. 1']);
  });

  it('matches across fields (text, title, comment), case-insensitive', () => {
    expect(searchParagraphs(list, 'unantastbar').map(paragraphLabel)).toEqual(['GG Art. 1']);
    expect(searchParagraphs(list, 'generalklausel').map(paragraphLabel)).toEqual(['BGB § 242']);
    expect(searchParagraphs(list, 'MENSCHEN').map(paragraphLabel)).toEqual(['GG Art. 1']);
  });
});

describe('buildContext', () => {
  it('summarizes empty and non-empty collections', () => {
    expect(buildContext([], 'en')).toContain('No statutes');
    const list = [makeParagraph({ jurisdiction: '', book: 'BGB', norm: '§ 1', section: '', title: '', text: '', comment: '' })];
    expect(buildContext(list, 'de')).toContain('1 Paragrafen');
    expect(buildContext(list, 'de')).toContain('BGB § 1');
  });
});
