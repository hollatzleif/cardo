import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import type {
  CardoTool,
  CommandResult,
  SelfTestContext,
  SelfTestResult,
  ToolContext,
  ToolStorage,
  WidgetProps,
} from '@cardo/plugin-api';
import manifest from '../manifest.json';
import {
  DEFAULT_REFRESH_MINUTES,
  ITEM_CAP,
  buildRssContext,
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
} from './logic';

/** fetch with hard timeout – bad networks must never hang the widget
 * (same pattern as the host's net.ts; tools cannot import host code). */
function fetchWithTimeout(url: string, timeoutMs = 10_000): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}

/* ── Storage helpers (shared by commands, widget and self-tests) ───────── */

async function listFeeds(storage: ToolStorage): Promise<FeedDoc[]> {
  const feeds = await storage.query<FeedDoc>({ where: [{ field: 'type', op: '=', value: 'feed' }] });
  return [...feeds].sort((a, b) => a.title.localeCompare(b.title));
}

async function listItems(storage: ToolStorage, feedId?: string): Promise<ItemDoc[]> {
  const where = [{ field: 'type', op: '=' as const, value: 'item' }];
  if (feedId) where.push({ field: 'feedId', op: '=' as const, value: feedId });
  return sortItems(await storage.query<ItemDoc>({ where }));
}

async function addFeed(
  storage: ToolStorage,
  rawUrl: string,
): Promise<'added' | 'duplicate' | 'invalid'> {
  const url = validateFeedUrl(rawUrl);
  if (!url) return 'invalid';
  const id = feedDocId(url);
  if ((await storage.get<FeedDoc>(id)) !== null) return 'duplicate';
  // Fetching happens lazily (widget gate / rss.refresh) – adding a feed
  // must work fully offline.
  const feed: FeedDoc = {
    type: 'feed',
    id,
    url,
    title: hostnameOf(url),
    lastFetchedMs: 0,
    lastAttemptMs: 0,
    broken: false,
  };
  await storage.set<FeedDoc>(id, feed);
  return 'added';
}

async function removeFeed(storage: ToolStorage, feed: FeedDoc): Promise<void> {
  for (const item of await listItems(storage, feed.id)) await storage.delete(item.id);
  await storage.delete(feed.id);
}

async function markItemsRead(storage: ToolStorage, feedId?: string): Promise<number> {
  const items = (await listItems(storage, feedId)).filter((item) => !item.read);
  for (const item of items) await storage.set<ItemDoc>(item.id, { ...item, read: true });
  return items.length;
}

/* ── The tool ─────────────────────────────────────────────────────────── */

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  async function refreshMinutes(c: ToolContext): Promise<number> {
    const setting = await c.settings.get<number>('refreshMinutes');
    return typeof setting === 'number' && Number.isFinite(setting) && setting >= 1
      ? setting
      : DEFAULT_REFRESH_MINUTES;
  }

  type FeedOutcome = 'ok' | 'offline' | 'throttled';

  /** Fetch one feed, merge items (read flags survive), prune to the cap. */
  async function refreshFeed(c: ToolContext, feed: FeedDoc, force: boolean): Promise<FeedOutcome> {
    const now = Date.now();
    const minMs = (await refreshMinutes(c)) * 60 * 1000;
    if (!force && now - feed.lastAttemptMs < minMs) return 'throttled';
    try {
      const res = await fetchWithTimeout(feed.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parseFeed(await res.text());
      if (isParseError(parsed)) throw new Error(parsed.error);

      const existing = await listItems(c.storage, feed.id);
      const byId = new Map(existing.map((item) => [item.id, item]));
      const merged = new Map<string, ItemDoc>(byId);
      for (const item of parsed.items) {
        const id = itemDocId(feed.id, item.guid);
        merged.set(id, {
          type: 'item',
          id,
          feedId: feed.id,
          guid: item.guid,
          title: item.title,
          link: item.link,
          publishedMs: item.publishedMs,
          read: byId.get(id)?.read ?? false, // read state survives refreshes
        });
      }
      const { keep, drop } = pruneOldest([...merged.values()], ITEM_CAP);
      for (const item of keep) {
        const before = byId.get(item.id);
        if (!before || before.read !== item.read || before.title !== item.title || before.link !== item.link) {
          await c.storage.set<ItemDoc>(item.id, item);
        }
      }
      for (const item of drop) await c.storage.delete(item.id);

      await c.storage.set<FeedDoc>(feed.id, {
        ...feed,
        title: parsed.title || feed.title,
        lastFetchedMs: now,
        lastAttemptMs: now,
        broken: false,
      });
      return 'ok';
    } catch {
      // Honesty rule: keep every stored item, just flag the feed as broken.
      await c.storage.set<FeedDoc>(feed.id, { ...feed, lastAttemptMs: now, broken: true });
      return 'offline';
    }
  }

  async function refreshAll(c: ToolContext, force: boolean): Promise<{ ok: number; failed: number }> {
    let ok = 0;
    let failed = 0;
    for (const feed of await listFeeds(c.storage)) {
      const outcome = await refreshFeed(c, feed, force);
      if (outcome === 'ok') ok++;
      if (outcome === 'offline') failed++;
    }
    return { ok, failed };
  }

  function openItem(c: ToolContext, item: ItemDoc): void {
    if (item.link && validateFeedUrl(item.link)) {
      window.open(item.link, '_blank', 'noopener,noreferrer');
    }
    if (!item.read) void c.storage.set<ItemDoc>(item.id, { ...item, read: true });
  }

  /* ── Widget ─────────────────────────────────────────────────────────── */

  function RssWidget(props: WidgetProps) {
    const [feeds, setFeeds] = useState<FeedDoc[] | null>(null);
    const [items, setItems] = useState<ItemDoc[]>([]);
    const [url, setUrl] = useState('');
    const [invalidUrl, setInvalidUrl] = useState(false);
    const [refreshing, setRefreshing] = useState(false);

    const reload = useCallback(async () => {
      const c = ctx;
      if (!c) return;
      const [feedDocs, itemDocs] = await Promise.all([listFeeds(c.storage), listItems(c.storage)]);
      setFeeds(feedDocs);
      setItems(itemDocs);
    }, []);

    useEffect(() => {
      let mounted = true;
      const safeReload = () => {
        if (mounted) void reload();
      };
      safeReload();
      const unsub = ctx?.storage.subscribe(safeReload);
      return () => {
        mounted = false;
        unsub?.();
      };
    }, [reload]);

    // Lazy fetch gate: on mount and every 5 min, refresh feeds whose last
    // ATTEMPT is older than the configured interval (refreshFeed throttles).
    useEffect(() => {
      let mounted = true;
      const gate = () => {
        const c = ctx;
        if (!c || !mounted) return;
        void refreshAll(c, false);
      };
      gate();
      const interval = window.setInterval(gate, 5 * 60 * 1000);
      return () => {
        mounted = false;
        window.clearInterval(interval);
      };
    }, []);

    const submitUrl = async () => {
      const c = ctx;
      if (!c || !url.trim()) return;
      const result = await c.commands.execute('rss.add-feed', { url });
      if (result.ok) {
        setUrl('');
        setInvalidUrl(false);
        void refreshAll(c, false); // fetch the new feed right away (lazily throttled)
      } else {
        setInvalidUrl(true);
      }
    };

    const manualRefresh = async () => {
      const c = ctx;
      if (!c) return;
      setRefreshing(true);
      await refreshAll(c, true);
      setRefreshing(false);
    };

    if (feeds === null) {
      return (
        <div className="c-muted" style={{ padding: 'var(--space-3)' }}>
          …
        </div>
      );
    }

    const lang = ctx?.i18n.language ?? 'en';
    const canSendToReadingList = ctx?.commands.has('reading-list.add') ?? false;
    const brokenFeeds = feeds.filter((f) => f.broken);

    const sendToReadingList = (item: ItemDoc) => {
      void ctx?.commands.execute('reading-list.add', { title: item.title, url: item.link });
    };

    const dateLabel = (ms: number): string => {
      if (ms <= 0) return '';
      try {
        return new Date(ms).toLocaleDateString(lang, { day: '2-digit', month: '2-digit' });
      } catch {
        return '';
      }
    };

    const itemRow = (item: ItemDoc, showFeed: boolean) => {
      const feedTitle = feeds.find((f) => f.id === item.feedId)?.title ?? '';
      return (
        <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
          <button
            className="c-btn c-btn--ghost"
            style={{
              flex: 1,
              minWidth: 0,
              justifyContent: 'flex-start',
              textAlign: 'left',
              padding: '2px var(--space-1)',
              fontWeight: item.read ? 400 : 600,
            }}
            title={item.link || item.title}
            onClick={() => {
              const c = ctx;
              if (c) openItem(c, item);
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {showFeed && feedTitle ? <span className="c-muted">{feedTitle} · </span> : null}
              {item.title}
            </span>
          </button>
          <span className="c-muted" style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
            {dateLabel(item.publishedMs)}
          </span>
          {canSendToReadingList && (
            <button
              className="c-btn c-btn--ghost"
              style={{ padding: '0 var(--space-1)', flexShrink: 0 }}
              aria-label={t('tool.rss.widget.sendToReadingList')}
              title={t('tool.rss.widget.sendToReadingList')}
              onClick={() => sendToReadingList(item)}
            >
              📑
            </button>
          )}
        </div>
      );
    };

    const empty = (
      <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
        {t('tool.rss.widget.empty')}
      </div>
    );

    let body;
    if (props.variant === 'headlines') {
      const unread = items.filter((item) => !item.read);
      body =
        feeds.length === 0 ? (
          empty
        ) : unread.length === 0 ? (
          <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
            {t('tool.rss.widget.allRead')}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {unread.map((item) => itemRow(item, true))}
          </div>
        );
    } else if (props.variant === 'cards') {
      body =
        feeds.length === 0 ? (
          empty
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {items.map((item) => {
              const feedTitle = feeds.find((f) => f.id === item.feedId)?.title ?? '';
              return (
                <div key={item.id} className="c-card" style={{ padding: 'var(--space-2)' }}>
                  <div className="c-muted" style={{ fontSize: 11, display: 'flex', gap: 'var(--space-2)' }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {feedTitle}
                    </span>
                    <span style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                      {dateLabel(item.publishedMs)}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                    <button
                      className="c-btn c-btn--ghost"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        justifyContent: 'flex-start',
                        textAlign: 'left',
                        padding: '2px 0',
                        fontWeight: item.read ? 400 : 600,
                      }}
                      title={item.link || item.title}
                      onClick={() => {
                        const c = ctx;
                        if (c) openItem(c, item);
                      }}
                    >
                      <span style={{ whiteSpace: 'normal' }}>{item.title}</span>
                    </button>
                    {canSendToReadingList && (
                      <button
                        className="c-btn c-btn--ghost"
                        style={{ padding: '0 var(--space-1)', flexShrink: 0 }}
                        aria-label={t('tool.rss.widget.sendToReadingList')}
                        title={t('tool.rss.widget.sendToReadingList')}
                        onClick={() => sendToReadingList(item)}
                      >
                        📑
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        );
    } else {
      /* list (default): items grouped by feed */
      body =
        feeds.length === 0 ? (
          empty
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {feeds.map((feed) => {
              const feedItems = items.filter((item) => item.feedId === feed.id);
              const unread = unreadCount(feedItems);
              return (
                <div key={feed.id} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontWeight: 600,
                        fontSize: '0.85em',
                      }}
                      title={feed.url}
                    >
                      {feed.title}
                    </span>
                    {unread > 0 && <span className="c-badge">{unread}</span>}
                    {feed.broken && (
                      <span style={{ color: 'var(--warning)', fontSize: 11, flexShrink: 0 }}>
                        {t('tool.rss.widget.feedBroken')}
                      </span>
                    )}
                    <button
                      className="c-btn c-btn--ghost"
                      style={{ padding: '0 var(--space-1)', color: 'var(--text-muted)', flexShrink: 0 }}
                      aria-label={t('tool.rss.widget.removeFeed', { title: feed.title })}
                      title={t('tool.rss.widget.removeFeed', { title: feed.title })}
                      onClick={() => {
                        const c = ctx;
                        if (c) void removeFeed(c.storage, feed);
                      }}
                    >
                      ×
                    </button>
                  </div>
                  {feedItems.length === 0 ? (
                    <span className="c-muted" style={{ fontSize: '0.85em' }}>
                      {feed.lastFetchedMs === 0 ? t('tool.rss.widget.notFetchedYet') : t('tool.rss.widget.noItems')}
                    </span>
                  ) : (
                    feedItems.map((item) => itemRow(item, false))
                  )}
                </div>
              );
            })}
          </div>
        );
    }

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
          height: '100%',
          padding: 'var(--space-2)',
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', gap: 'var(--space-1)', flexShrink: 0 }}>
          <input
            className="c-input"
            value={url}
            placeholder={t('tool.rss.widget.urlPlaceholder')}
            aria-label={t('tool.rss.widget.urlPlaceholder')}
            style={{ flex: 1, minWidth: 0 }}
            onChange={(e) => {
              setUrl(e.target.value);
              setInvalidUrl(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitUrl();
            }}
          />
          <button
            className="c-btn c-btn--primary"
            aria-label={t('tool.rss.widget.addFeed')}
            title={t('tool.rss.widget.addFeed')}
            style={{ flexShrink: 0 }}
            disabled={!url.trim()}
            onClick={() => void submitUrl()}
          >
            +
          </button>
          <button
            className="c-btn c-btn--ghost"
            aria-label={t('tool.rss.widget.refresh')}
            title={t('tool.rss.widget.refresh')}
            style={{ flexShrink: 0 }}
            disabled={refreshing || feeds.length === 0}
            onClick={() => void manualRefresh()}
          >
            ↻
          </button>
        </div>
        {invalidUrl && (
          <span style={{ color: 'var(--warning)', fontSize: '0.8em', flexShrink: 0 }}>
            {t('tool.rss.widget.invalidUrl')}
          </span>
        )}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{body}</div>
        {brokenFeeds.length > 0 && (
          <span className="c-muted" style={{ fontSize: '0.8em', flexShrink: 0 }}>
            {t('tool.rss.widget.offlineHint', { count: brokenFeeds.length })}
          </span>
        )}
      </div>
    );
  }

  /* ── Tool ───────────────────────────────────────────────────────────── */

  return {
    manifest: manifest as CardoTool['manifest'],

    activate(context: ToolContext) {
      ctx = context;

      // NOTE: rss.refresh is registered FIRST on purpose. The diagnose
      // command probe executes commands in registration order against an
      // empty scratch DB – refresh sees no feeds (→ no network) BEFORE
      // rss.add-feed's probe creates one.
      context.commands.register({
        id: 'rss.refresh',
        titleKey: 'tool.rss.command.refresh',
        descriptionKey: 'tool.rss.command.refreshDesc',
        icon: '↻',
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const feeds = await listFeeds(context.storage);
          if (feeds.length === 0) return { ok: true, messageKey: 'tool.rss.msg.noFeeds' };
          const { ok, failed } = await refreshAll(context, true);
          // Offline is a normal condition: items stay put, feeds get flagged.
          if (ok === 0 && failed > 0) return { ok: true, messageKey: 'tool.rss.msg.offline' };
          return { ok: true, messageKey: 'tool.rss.msg.refreshed' };
        },
      });

      context.commands.register({
        id: 'rss.add-feed',
        titleKey: 'tool.rss.command.addFeed',
        descriptionKey: 'tool.rss.command.addFeedDesc',
        icon: 'plus',
        params: z.object({ url: z.string().min(1) }),
        selfTestParams: { url: 'https://example.org/feed.xml' },
        async run(params): Promise<CommandResult> {
          // Adding only stores the subscription – the fetch happens lazily,
          // so this command works fully offline.
          const outcome = await addFeed(context.storage, params.url);
          if (outcome === 'invalid') return { ok: false, messageKey: 'tool.rss.msg.invalidUrl' };
          if (outcome === 'duplicate') return { ok: true, messageKey: 'tool.rss.msg.feedExists' };
          return { ok: true, messageKey: 'tool.rss.msg.feedAdded' };
        },
      });

      context.commands.register({
        id: 'rss.mark-read',
        titleKey: 'tool.rss.command.markRead',
        descriptionKey: 'tool.rss.command.markReadDesc',
        palette: false,
        assistant: true,
        params: z.object({ feed: z.string().optional() }),
        selfTestParams: {},
        async run(params): Promise<CommandResult> {
          let feedId: string | undefined;
          if (params.feed) {
            const needle = params.feed.trim().toLowerCase();
            const match = (await listFeeds(context.storage)).find(
              (f) => f.title.toLowerCase() === needle || hostnameOf(f.url).toLowerCase() === needle,
            );
            if (!match) return { ok: false, messageKey: 'tool.rss.msg.feedNotFound' };
            feedId = match.id;
          }
          const count = await markItemsRead(context.storage, feedId);
          return { ok: true, messageKey: 'tool.rss.msg.markedRead', data: { count } };
        },
      });

      context.commands.register({
        id: 'rss.context',
        titleKey: 'tool.rss.command.context',
        descriptionKey: 'tool.rss.command.contextDesc',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const [feeds, items] = await Promise.all([
            listFeeds(context.storage),
            listItems(context.storage),
          ]);
          return {
            ok: true,
            data: { contextText: buildRssContext(feeds, items, context.i18n.language) },
          };
        },
      });
    },

    deactivate() {
      ctx = null;
    },

    Widget: RssWidget,

    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'parser': {
          // Pure fixtures through the real parser – NO network involved.
          const rss = parseFeed(
            '<rss version="2.0"><channel><title>SelfTest</title>' +
              '<item><title>A</title><link>https://example.org/a</link><guid>a-1</guid>' +
              '<pubDate>Mon, 13 Jul 2026 08:30:00 GMT</pubDate></item>' +
              '<item><title>B</title><link>https://example.org/b</link></item>' +
              '</channel></rss>',
          );
          if (isParseError(rss)) return { status: 'fail', detail: `RSS fixture: ${rss.error}` };
          if (rss.title !== 'SelfTest' || rss.items.length !== 2) {
            return { status: 'fail', detail: `RSS parse mismatch: ${JSON.stringify(rss)}` };
          }
          if (rss.items[0]?.guid !== 'a-1' || rss.items[1]?.guid !== 'https://example.org/b') {
            return { status: 'fail', detail: 'guid / link-fallback broken' };
          }
          const atom = parseFeed(
            '<feed xmlns="http://www.w3.org/2005/Atom"><title>AtomTest</title>' +
              '<entry><title>C</title><id>c-1</id><link href="https://example.org/c"/>' +
              '<updated>2026-07-14T09:00:00Z</updated></entry></feed>',
          );
          if (isParseError(atom)) return { status: 'fail', detail: `Atom fixture: ${atom.error}` };
          if (atom.title !== 'AtomTest' || atom.items[0]?.link !== 'https://example.org/c') {
            return { status: 'fail', detail: `Atom parse mismatch: ${JSON.stringify(atom)}` };
          }
          const bad = parseFeed('<rss><channel>');
          if (!isParseError(bad)) return { status: 'fail', detail: 'malformed XML did not error' };
          return { status: 'pass', detail: 'RSS 2.0 + Atom fixtures parsed, malformed XML rejected' };
        }
        case 'crud': {
          const outcome = await addFeed(testCtx.storage, 'https://selftest.example.org/feed.xml');
          if (outcome !== 'added') return { status: 'fail', detail: `addFeed: ${outcome}` };
          const dup = await addFeed(testCtx.storage, 'https://selftest.example.org/feed.xml');
          if (dup !== 'duplicate') return { status: 'fail', detail: 'duplicate not detected' };
          const feed = (await listFeeds(testCtx.storage)).find(
            (f) => f.url === 'https://selftest.example.org/feed.xml',
          );
          if (!feed) return { status: 'fail', detail: 'feed not stored' };
          const itemId = itemDocId(feed.id, 'selftest-guid');
          await testCtx.storage.set<ItemDoc>(itemId, {
            type: 'item',
            id: itemId,
            feedId: feed.id,
            guid: 'selftest-guid',
            title: 'SelfTest item',
            link: 'https://selftest.example.org/1',
            publishedMs: 1_700_000_000_000,
            read: false,
          });
          const marked = await markItemsRead(testCtx.storage, feed.id);
          const item = await testCtx.storage.get<ItemDoc>(itemId);
          await removeFeed(testCtx.storage, feed);
          const gone = await testCtx.storage.get<ItemDoc>(itemId);
          if (marked !== 1 || item?.read !== true) {
            return { status: 'fail', detail: `mark-read roundtrip failed: ${JSON.stringify(item)}` };
          }
          if (gone !== null || (await testCtx.storage.get<FeedDoc>(feed.id)) !== null) {
            return { status: 'fail', detail: 'removeFeed left documents behind' };
          }
          return { status: 'pass', detail: 'feed + item roundtrip incl. mark-read and cascade delete' };
        }
        case 'render':
          return typeof RssWidget === 'function' && RssWidget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget export contract violated' };
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
