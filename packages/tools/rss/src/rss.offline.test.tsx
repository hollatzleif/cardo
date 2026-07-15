// @vitest-environment jsdom
//
// Offline behavior of the RSS tool (same pattern as the weather tool's
// offline suite): a dead network must never crash a command, never
// hard-fail and never destroy stored items. Adding feeds and marking
// items read are local operations and must work with fetch rejecting.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestContext } from '@cardo/plugin-api/testing';
import { createTool } from './index';
import { feedDocId, itemDocId, type FeedDoc, type ItemDoc } from './logic';

beforeAll(() => {
  // jsdom lacks the static AbortSignal.timeout the tool's fetchWithTimeout
  // uses – polyfill it so the real code path runs.
  const AS = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
  if (typeof AS.timeout !== 'function') {
    AS.timeout = (ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    };
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const FEED_URL = 'https://blog.example.org/feed.xml';
const FEED_ID = feedDocId(FEED_URL);

const FEED: FeedDoc = {
  type: 'feed',
  id: FEED_ID,
  url: FEED_URL,
  title: 'Beispiel-Blog',
  lastFetchedMs: Date.now() - 60 * 60 * 1000,
  lastAttemptMs: Date.now() - 60 * 60 * 1000,
  broken: false,
};

function mkItem(guid: string, read = false): ItemDoc {
  const id = itemDocId(FEED_ID, guid);
  return {
    type: 'item',
    id,
    feedId: FEED_ID,
    guid,
    title: `Artikel ${guid}`,
    link: `https://blog.example.org/posts/${guid}`,
    publishedMs: 1_700_000_000_000,
    read,
  };
}

async function activatedTool() {
  const ctx = createTestContext();
  const tool = createTool();
  await tool.activate(ctx);
  return { ctx, tool };
}

function deadFetch() {
  const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('rss.add-feed works fully offline', () => {
  it('stores the subscription without any network call', async () => {
    const { ctx } = await activatedTool();
    const fetchMock = deadFetch();

    const result = await ctx.commands.execute('rss.add-feed', { url: FEED_URL });

    expect(result.ok).toBe(true);
    expect(result.messageKey?.endsWith('feedAdded')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const stored = await ctx.storage.get<FeedDoc>(FEED_ID);
    expect(stored?.url).toBe(FEED_URL);
    expect(stored?.title).toBe('blog.example.org'); // hostname until first fetch
    expect(stored?.lastFetchedMs).toBe(0);
  });

  it('rejects an invalid URL cleanly, ok on duplicates', async () => {
    const { ctx } = await activatedTool();
    deadFetch();

    const bad = await ctx.commands.execute('rss.add-feed', { url: 'not a url' });
    expect(bad.ok).toBe(false);
    expect(bad.messageKey?.endsWith('invalidUrl')).toBe(true);

    await ctx.commands.execute('rss.add-feed', { url: FEED_URL });
    const dup = await ctx.commands.execute('rss.add-feed', { url: FEED_URL });
    expect(dup.ok).toBe(true);
    expect(dup.messageKey?.endsWith('feedExists')).toBe(true);
  });
});

describe('rss.refresh when the network is down', () => {
  it('reports ok/offline, keeps every item and flags the feed as broken', async () => {
    const { ctx } = await activatedTool();
    await ctx.storage.set<FeedDoc>(FEED_ID, FEED);
    const items = [mkItem('a'), mkItem('b', true)];
    for (const item of items) await ctx.storage.set<ItemDoc>(item.id, item);
    const fetchMock = deadFetch();

    const result = await ctx.commands.execute('rss.refresh', {});

    expect(result.ok).toBe(true);
    expect(result.messageKey?.endsWith('offline')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(FEED_URL);
    // Honesty rule: items untouched, feed flagged – no error wall.
    for (const item of items) {
      expect(await ctx.storage.get<ItemDoc>(item.id)).toEqual(item);
    }
    expect((await ctx.storage.get<FeedDoc>(FEED_ID))?.broken).toBe(true);
  });

  it('resolves ok with noFeeds (and NO network call) on an empty store', async () => {
    const { ctx } = await activatedTool();
    const fetchMock = deadFetch();

    const result = await ctx.commands.execute('rss.refresh', {});

    expect(result.ok).toBe(true);
    expect(result.messageKey?.endsWith('noFeeds')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses a live payload and preserves read flags across a refresh', async () => {
    const { ctx } = await activatedTool();
    await ctx.storage.set<FeedDoc>(FEED_ID, FEED);
    const readItem = mkItem('post-1', true);
    await ctx.storage.set<ItemDoc>(readItem.id, readItem);
    const xml =
      '<rss version="2.0"><channel><title>Beispiel-Blog</title>' +
      '<item><title>Artikel post-1</title><link>https://blog.example.org/posts/post-1</link><guid>post-1</guid></item>' +
      '<item><title>Neu</title><link>https://blog.example.org/posts/post-2</link><guid>post-2</guid></item>' +
      '</channel></rss>';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => xml }),
    );

    const result = await ctx.commands.execute('rss.refresh', {});

    expect(result.ok).toBe(true);
    expect(result.messageKey?.endsWith('refreshed')).toBe(true);
    // The previously read item stays read, the new one arrives unread.
    expect((await ctx.storage.get<ItemDoc>(readItem.id))?.read).toBe(true);
    expect((await ctx.storage.get<ItemDoc>(itemDocId(FEED_ID, 'post-2')))?.read).toBe(false);
    expect((await ctx.storage.get<FeedDoc>(FEED_ID))?.broken).toBe(false);
  });
});

describe('rss.mark-read and rss.context (local, offline-safe)', () => {
  it('marks everything read without network', async () => {
    const { ctx } = await activatedTool();
    await ctx.storage.set<FeedDoc>(FEED_ID, FEED);
    for (const item of [mkItem('a'), mkItem('b')]) await ctx.storage.set<ItemDoc>(item.id, item);
    const fetchMock = deadFetch();

    const result = await ctx.commands.execute('rss.mark-read', {});

    expect(result.ok).toBe(true);
    expect((result.data as { count: number }).count).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await ctx.storage.get<ItemDoc>(mkItem('a').id))?.read).toBe(true);
  });

  it('marks a single feed by title, fails cleanly on unknown feeds', async () => {
    const { ctx } = await activatedTool();
    await ctx.storage.set<FeedDoc>(FEED_ID, FEED);
    await ctx.storage.set<ItemDoc>(mkItem('a').id, mkItem('a'));
    deadFetch();

    const byTitle = await ctx.commands.execute('rss.mark-read', { feed: 'beispiel-blog' });
    expect(byTitle.ok).toBe(true);
    expect((byTitle.data as { count: number }).count).toBe(1);

    const unknown = await ctx.commands.execute('rss.mark-read', { feed: 'Gibt es nicht' });
    expect(unknown.ok).toBe(false);
    expect(unknown.messageKey?.endsWith('feedNotFound')).toBe(true);
  });

  it('context summarizes unread counts offline', async () => {
    const { ctx } = await activatedTool();
    await ctx.storage.set<FeedDoc>(FEED_ID, { ...FEED, broken: true });
    for (const item of [mkItem('a'), mkItem('b', true)]) {
      await ctx.storage.set<ItemDoc>(item.id, item);
    }
    deadFetch();

    const result = await ctx.commands.execute('rss.context', {});

    expect(result.ok).toBe(true);
    const text = (result.data as { contextText: string }).contextText;
    expect(text).toContain('1 feeds, 1 unread');
    expect(text).toContain('unreachable');
  });
});

describe('self-tests run without network', () => {
  it('parser + crud self-tests pass with fetch dead', async () => {
    const { ctx, tool } = await activatedTool();
    const fetchMock = deadFetch();
    expect((await tool.runSelfTest('parser', ctx)).status).toBe('pass');
    expect((await tool.runSelfTest('crud', ctx)).status).toBe('pass');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
