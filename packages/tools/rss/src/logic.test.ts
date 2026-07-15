// @vitest-environment jsdom
// parseFeed relies on DOMParser, which lives in the webview at runtime –
// jsdom provides the same API for the tests.
import { describe, expect, it } from 'vitest';
import {
  ITEM_CAP,
  buildRssContext,
  djb2Hex,
  feedDocId,
  hostnameOf,
  isParseError,
  itemDocId,
  parseFeed,
  pruneOldest,
  sortItems,
  unreadCount,
  validateFeedUrl,
  type FeedDoc,
  type ItemDoc,
  type ParsedFeed,
} from './logic';

/* ── Fixtures (realistic, namespaced, imperfect – like the wild web) ───── */

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Beispiel-Blog</title>
    <link>https://blog.example.org/</link>
    <description>Ein Blog.</description>
    <atom:link href="https://blog.example.org/feed.xml" rel="self"/>
    <item>
      <title>Erster Artikel</title>
      <link>https://blog.example.org/posts/1</link>
      <guid isPermaLink="false">post-0001</guid>
      <pubDate>Mon, 13 Jul 2026 08:30:00 GMT</pubDate>
      <dc:creator>Leif</dc:creator>
    </item>
    <item>
      <title>Ohne guid – Link muss reichen</title>
      <link>https://blog.example.org/posts/2</link>
      <pubDate>Sun, 12 Jul 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Ohne Datum</title>
      <link>https://blog.example.org/posts/3</link>
      <guid>post-0003</guid>
    </item>
    <item>
      <description>Weder Titel noch Link noch guid – wird übersprungen.</description>
    </item>
  </channel>
</rss>`;

const ATOM_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Releases</title>
  <id>urn:example:releases</id>
  <updated>2026-07-14T12:00:00Z</updated>
  <entry>
    <title>v2.0 released</title>
    <id>urn:example:release:2.0</id>
    <link rel="alternate" href="https://example.org/releases/2.0"/>
    <link rel="enclosure" href="https://example.org/releases/2.0.tar.gz"/>
    <published>2026-07-14T09:00:00Z</published>
    <updated>2026-07-14T10:00:00Z</updated>
  </entry>
  <entry>
    <title>v1.9 released</title>
    <link href="https://example.org/releases/1.9"/>
    <updated>2026-06-01T09:00:00Z</updated>
  </entry>
</feed>`;

function parsedOrFail(xml: string): ParsedFeed {
  const parsed = parseFeed(xml);
  if (isParseError(parsed)) throw new Error(`unexpected parse error: ${parsed.error}`);
  return parsed;
}

/* ── parseFeed ─────────────────────────────────────────────────────────── */

describe('parseFeed: RSS 2.0', () => {
  const feed = parsedOrFail(RSS_FIXTURE);

  it('reads the channel title and all keyable items', () => {
    expect(feed.title).toBe('Beispiel-Blog');
    // The guid/link/title-less item is skipped, the other three survive.
    expect(feed.items).toHaveLength(3);
  });

  it('uses guid when present', () => {
    expect(feed.items[0]?.guid).toBe('post-0001');
    expect(feed.items[0]?.title).toBe('Erster Artikel');
    expect(feed.items[0]?.link).toBe('https://blog.example.org/posts/1');
    expect(feed.items[0]?.publishedMs).toBe(Date.parse('Mon, 13 Jul 2026 08:30:00 GMT'));
  });

  it('falls back to the link when guid is missing', () => {
    expect(feed.items[1]?.guid).toBe('https://blog.example.org/posts/2');
  });

  it('missing pubDate becomes 0, not NaN', () => {
    expect(feed.items[2]?.publishedMs).toBe(0);
  });
});

describe('parseFeed: Atom', () => {
  const feed = parsedOrFail(ATOM_FIXTURE);

  it('reads the feed title and entries', () => {
    expect(feed.title).toBe('Example Releases');
    expect(feed.items).toHaveLength(2);
  });

  it('prefers the alternate link and the published date', () => {
    expect(feed.items[0]?.guid).toBe('urn:example:release:2.0');
    expect(feed.items[0]?.link).toBe('https://example.org/releases/2.0');
    expect(feed.items[0]?.publishedMs).toBe(Date.parse('2026-07-14T09:00:00Z'));
  });

  it('falls back to link-as-id and updated-as-date', () => {
    expect(feed.items[1]?.guid).toBe('https://example.org/releases/1.9');
    expect(feed.items[1]?.publishedMs).toBe(Date.parse('2026-06-01T09:00:00Z'));
  });
});

describe('parseFeed: hostile input', () => {
  it('malformed XML → error, no throw', () => {
    const parsed = parseFeed('<rss><channel><title>kaputt</channel>');
    expect(isParseError(parsed)).toBe(true);
    if (isParseError(parsed)) expect(parsed.error).toBe('malformed-xml');
  });

  it('valid XML that is not a feed → not-a-feed', () => {
    const parsed = parseFeed('<html><body><p>Kein Feed.</p></body></html>');
    expect(isParseError(parsed)).toBe(true);
    if (isParseError(parsed)) expect(parsed.error).toBe('not-a-feed');
  });

  it('empty string → error', () => {
    expect(isParseError(parseFeed(''))).toBe(true);
  });
});

/* ── ids ───────────────────────────────────────────────────────────────── */

describe('hashing', () => {
  it('djb2Hex is stable across calls (persisted ids depend on it)', () => {
    expect(djb2Hex('hello')).toBe(djb2Hex('hello'));
    expect(djb2Hex('hello')).toMatch(/^[0-9a-f]+$/);
    expect(djb2Hex('hello')).not.toBe(djb2Hex('hellp'));
  });

  it('feed and item ids are namespaced and deterministic', () => {
    const feedId = feedDocId('https://blog.example.org/feed.xml');
    expect(feedId.startsWith('feed:')).toBe(true);
    expect(feedDocId('https://blog.example.org/feed.xml')).toBe(feedId);
    const itemId = itemDocId(feedId, 'post-0001');
    expect(itemId.startsWith('item:')).toBe(true);
    expect(itemDocId(feedId, 'post-0001')).toBe(itemId);
    // Same guid under a different feed must NOT collide.
    expect(itemDocId('feed:other', 'post-0001')).not.toBe(itemId);
  });
});

/* ── url validation ───────────────────────────────────────────────────── */

describe('validateFeedUrl', () => {
  it('accepts http/https and normalizes', () => {
    expect(validateFeedUrl(' https://example.org/feed ')).toBe('https://example.org/feed');
    expect(validateFeedUrl('http://example.org')).toBe('http://example.org/');
  });

  it('rejects everything else', () => {
    expect(validateFeedUrl('ftp://example.org/feed')).toBeNull();
    expect(validateFeedUrl('javascript:alert(1)')).toBeNull();
    expect(validateFeedUrl('feed.example.org')).toBeNull();
    expect(validateFeedUrl('')).toBeNull();
  });

  it('hostnameOf extracts the host (fallback: raw input)', () => {
    expect(hostnameOf('https://blog.example.org/feed.xml')).toBe('blog.example.org');
    expect(hostnameOf('nonsense')).toBe('nonsense');
  });
});

/* ── bookkeeping ──────────────────────────────────────────────────────── */

const mkItem = (id: string, publishedMs: number, read = false): ItemDoc => ({
  type: 'item',
  id: `item:${id}`,
  feedId: 'feed:1',
  guid: id,
  title: id,
  link: `https://example.org/${id}`,
  publishedMs,
  read,
});

describe('sortItems / unreadCount / pruneOldest', () => {
  it('sorts newest first, deterministic on date ties', () => {
    const sorted = sortItems([mkItem('b', 1), mkItem('c', 5), mkItem('a', 1)]);
    expect(sorted.map((i) => i.guid)).toEqual(['c', 'a', 'b']);
  });

  it('counts unread', () => {
    expect(unreadCount([mkItem('a', 1, true), mkItem('b', 2), mkItem('c', 3)])).toBe(2);
    expect(unreadCount([])).toBe(0);
  });

  it('pruneOldest keeps the cap newest and drops the rest', () => {
    const items = [mkItem('a', 1), mkItem('b', 2), mkItem('c', 3), mkItem('d', 4)];
    const { keep, drop } = pruneOldest(items, 2);
    expect(keep.map((i) => i.guid)).toEqual(['d', 'c']);
    expect(drop.map((i) => i.guid)).toEqual(['b', 'a']);
  });

  it('pruneOldest is a no-op below the cap and defensive on cap 0', () => {
    const items = [mkItem('a', 1), mkItem('b', 2)];
    expect(pruneOldest(items, ITEM_CAP).drop).toHaveLength(0);
    expect(pruneOldest(items, 0).keep).toHaveLength(0);
  });
});

/* ── context ──────────────────────────────────────────────────────────── */

describe('buildRssContext', () => {
  const feed = (id: string, title: string, broken = false): FeedDoc => ({
    type: 'feed',
    id: `feed:${id}`,
    url: `https://example.org/${id}`,
    title,
    lastFetchedMs: 0,
    lastAttemptMs: 0,
    broken,
  });

  it('empty state', () => {
    expect(buildRssContext([], [], 'en')).toBe('No feeds subscribed.');
    expect(buildRssContext([], [], 'de')).toBe('Keine Feeds abonniert.');
  });

  it('unread per feed, honest about broken feeds', () => {
    const feeds = [feed('1', 'Blog'), feed('2', 'News', true)];
    const items = [
      { ...mkItem('a', 1), feedId: 'feed:1' },
      { ...mkItem('b', 2, true), feedId: 'feed:1' },
      { ...mkItem('c', 3), feedId: 'feed:2' },
    ];
    const en = buildRssContext(feeds, items, 'en');
    expect(en).toContain('2 feeds, 2 unread articles.');
    expect(en).toContain('"Blog": 1 unread');
    expect(en).toContain('"News": 1 unread, unreachable');
    const de = buildRssContext(feeds, items, 'de-DE');
    expect(de).toContain('2 Feeds, 2 ungelesene Artikel.');
    expect(de).toContain('«News»: 1 ungelesen, nicht erreichbar');
  });
});
