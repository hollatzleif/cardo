import { describe, expect, it } from 'vitest';
import {
  buildBookmarksContext,
  domainOf,
  folderToken,
  groupByFolder,
  letterAvatar,
  makeId,
  makeLink,
  sortLinks,
  topLinks,
  validateUrl,
  type LinkDoc,
} from './logic';

function link(overrides: Partial<LinkDoc>): LinkDoc {
  return {
    id: 'link:base',
    type: 'link',
    url: 'https://example.com/',
    title: 'Example',
    folder: '',
    createdAt: '2026-07-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('makeId / makeLink', () => {
  it('is prefixed and unique', () => {
    const ids = new Set(Array.from({ length: 100 }, () => makeId()));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id.startsWith('link:')).toBe(true);
  });

  it('trims title/folder and defaults the folder to unfiled', () => {
    const doc = makeLink(
      { url: 'https://example.com/', title: '  Docs  ', folder: '  Work  ' },
      new Date('2026-07-01T10:00:00Z'),
    );
    expect(doc.type).toBe('link');
    expect(doc.title).toBe('Docs');
    expect(doc.folder).toBe('Work');
    expect(doc.createdAt).toBe('2026-07-01T10:00:00.000Z');
    expect(makeLink({ url: 'https://example.com/', title: 'x' }).folder).toBe('');
  });
});

describe('validateUrl', () => {
  it('accepts http and https URLs and normalizes them', () => {
    expect(validateUrl('https://example.com')).toBe('https://example.com/');
    expect(validateUrl('http://example.com/path?q=1#frag')).toBe('http://example.com/path?q=1#frag');
    expect(validateUrl('  https://example.com  ')).toBe('https://example.com/');
  });

  it('keeps ports and subdomains', () => {
    expect(validateUrl('http://localhost:3000/dev')).toBe('http://localhost:3000/dev');
    expect(validateUrl('https://api.staging.example.co.uk:8443/x')).toBe(
      'https://api.staging.example.co.uk:8443/x',
    );
  });

  it('upgrades scheme-less input to https', () => {
    expect(validateUrl('example.com')).toBe('https://example.com/');
    expect(validateUrl('www.example.com/deep/link')).toBe('https://www.example.com/deep/link');
  });

  it('rejects XSS and non-web schemes', () => {
    expect(validateUrl('javascript:alert(1)')).toBeNull();
    expect(validateUrl('JavaScript:alert(1)')).toBeNull();
    expect(validateUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(validateUrl('vbscript:msgbox(1)')).toBeNull();
    expect(validateUrl('file:///etc/passwd')).toBeNull();
    expect(validateUrl('ftp://example.com/file')).toBeNull();
    expect(validateUrl('mailto:leif@example.com')).toBeNull();
  });

  it('rejects garbage, empty input and hostless URLs', () => {
    expect(validateUrl('')).toBeNull();
    expect(validateUrl('   ')).toBeNull();
    expect(validateUrl('not a url')).toBeNull();
    expect(validateUrl('https://')).toBeNull();
    expect(validateUrl('foo')).toBeNull();
    // Scheme-less host:port parses as a scheme – must not slip through.
    expect(validateUrl('localhost:3000')).toBeNull();
  });
});

describe('domainOf', () => {
  it('extracts the hostname without port', () => {
    expect(domainOf('https://example.com:8443/path')).toBe('example.com');
    expect(domainOf('http://localhost:3000/')).toBe('localhost');
  });

  it('keeps subdomains but strips a leading www.', () => {
    expect(domainOf('https://api.staging.example.com/')).toBe('api.staging.example.com');
    expect(domainOf('https://www.example.com/')).toBe('example.com');
  });

  it('returns an empty string for invalid input', () => {
    expect(domainOf('not a url')).toBe('');
  });
});

describe('letterAvatar', () => {
  it('uppercases the first grapheme', () => {
    expect(letterAvatar('github')).toBe('G');
    expect(letterAvatar('  docs')).toBe('D');
    expect(letterAvatar('ärzte')).toBe('Ä');
  });

  it('keeps emoji and multi-code-point graphemes intact', () => {
    expect(letterAvatar('👍 likes')).toBe('👍');
    expect(letterAvatar('👨‍👩‍👧 family')).toBe('👨‍👩‍👧');
  });

  it('falls back to # for empty titles', () => {
    expect(letterAvatar('')).toBe('#');
    expect(letterAvatar('   ')).toBe('#');
  });
});

describe('folderToken', () => {
  it('is deterministic and within chart-1..8', () => {
    expect(folderToken('Work')).toBe(folderToken('Work'));
    for (const folder of ['', 'Work', 'News', 'Dev', 'Ärzte', '日本語']) {
      expect(folderToken(folder)).toMatch(/^chart-[1-8]$/);
    }
  });

  it('usually differs between folder names', () => {
    const tokens = new Set(['Work', 'News', 'Dev', 'Fun'].map(folderToken));
    expect(tokens.size).toBeGreaterThan(1);
  });
});

describe('sortLinks / groupByFolder', () => {
  const work1 = link({ id: 'link:w1', title: 'zeta', folder: 'Work' });
  const work2 = link({ id: 'link:w2', title: 'Alpha', folder: 'Work' });
  const news = link({ id: 'link:n1', title: 'mid', folder: 'news' });
  const unfiled = link({ id: 'link:u1', title: 'loose' });

  it('sorts links case-insensitively by title', () => {
    expect(sortLinks([work1, work2]).map((l) => l.id)).toEqual(['link:w2', 'link:w1']);
  });

  it('groups with unfiled first, then folders alphabetically (case-insensitive)', () => {
    const groups = groupByFolder([work1, news, unfiled, work2]);
    expect(groups.map((g) => g.folder)).toEqual(['', 'news', 'Work']);
    expect(groups[1]?.links.map((l) => l.id)).toEqual(['link:n1']);
    expect(groups[2]?.links.map((l) => l.id)).toEqual(['link:w2', 'link:w1']);
  });

  it('returns no empty groups', () => {
    expect(groupByFolder([])).toEqual([]);
  });
});

describe('topLinks', () => {
  it('returns the most recently added links, capped at n', () => {
    const links = Array.from({ length: 10 }, (_, i) =>
      link({ id: `link:${i}`, createdAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` }),
    );
    const top = topLinks(links);
    expect(top).toHaveLength(8);
    expect(top[0]?.id).toBe('link:9');
    expect(top[7]?.id).toBe('link:2');
    expect(topLinks(links, 3)).toHaveLength(3);
  });
});

describe('buildBookmarksContext', () => {
  it('reports an empty collection in both languages', () => {
    expect(buildBookmarksContext([], 'en')).toBe('No bookmarks saved.');
    expect(buildBookmarksContext([], 'de')).toBe('Keine Lesezeichen gespeichert.');
  });

  it('lists links per folder with their domains', () => {
    const text = buildBookmarksContext(
      [
        link({ id: 'link:a', title: 'Repo', url: 'https://github.com/x', folder: 'Dev' }),
        link({ id: 'link:b', title: 'Home', url: 'https://www.example.com/' }),
      ],
      'en',
    );
    expect(text).toContain('2 bookmarks');
    expect(text).toContain('Unfiled: «Home» (example.com)');
    expect(text).toContain('Dev: «Repo» (github.com)');
  });

  it('labels unfiled links in German', () => {
    const text = buildBookmarksContext([link({ title: 'Start' })], 'de');
    expect(text).toContain('1 Lesezeichen');
    expect(text).toContain('Ohne Ordner: «Start» (example.com)');
  });
});
