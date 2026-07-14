import { describe, expect, it } from 'vitest';
import { extractWikiLinks, linksTo } from './markdown';

describe('wiki-link extraction', () => {
  it('finds every [[link]] and dedupes', () => {
    const md = 'See [[Alpha]] and [[Beta]], again [[Alpha]].';
    expect(extractWikiLinks(md)).toEqual(['Alpha', 'Beta']);
  });

  it('uses the target before a | alias', () => {
    expect(extractWikiLinks('[[Packliste|meine Liste]]')).toEqual(['Packliste']);
  });

  it('trims whitespace inside the brackets', () => {
    expect(extractWikiLinks('[[  Reise  ]]')).toEqual(['Reise']);
  });

  it('returns nothing when there are no links', () => {
    expect(extractWikiLinks('plain text, no links')).toEqual([]);
  });

  it('linksTo is case-insensitive and ignores the .md suffix', () => {
    const md = 'related: [[Reise]]';
    expect(linksTo(md, 'reise.md')).toBe(true);
    expect(linksTo(md, 'REISE')).toBe(true);
    expect(linksTo(md, 'Anderes')).toBe(false);
  });
});
