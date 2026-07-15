/**
 * Pure RSS/Atom logic – parsing, hashing, pruning. No host access; the
 * only browser API used is DOMParser (available in the webview and in
 * jsdom test environments). Everything network lives in index.tsx.
 */

/* ── Storage document shapes ──────────────────────────────────────────── */

/** Storage doc `feed:<hash>` – one subscribed feed. */
export type FeedDoc = {
  type: 'feed';
  /** Doc id, `feed:<djb2(url)>` – stored inside the doc for deletes. */
  id: string;
  url: string;
  /** Feed title from the last successful fetch (hostname until then). */
  title: string;
  /** Epoch ms of the last SUCCESSFUL fetch (0 = never). */
  lastFetchedMs: number;
  /** Epoch ms of the last fetch ATTEMPT – throttles retries. */
  lastAttemptMs: number;
  /** True when the last attempt failed – shown as a muted hint, honestly. */
  broken: boolean;
};

/** Storage doc `item:<hash>` – one feed item. */
export type ItemDoc = {
  type: 'item';
  /** Doc id, `item:<djb2(feedId|guid)>` – stored inside the doc for deletes. */
  id: string;
  feedId: string;
  guid: string;
  title: string;
  link: string;
  publishedMs: number;
  read: boolean;
};

/** Hard cap of stored items per feed – oldest beyond this are pruned. */
export const ITEM_CAP = 100;

/** Default minimum minutes between fetch attempts per feed. */
export const DEFAULT_REFRESH_MINUTES = 30;

/* ── Stable ids ───────────────────────────────────────────────────────── */

/** djb2 hash as unsigned hex – tiny, stable, good enough for doc ids. */
export function djb2Hex(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

export function feedDocId(url: string): string {
  return `feed:${djb2Hex(url)}`;
}

/** Stable item id from feed + the item's most stable key (guid, else link). */
export function itemDocId(feedId: string, key: string): string {
  return `item:${djb2Hex(`${feedId}|${key}`)}`;
}

/* ── Feed parsing (RSS 2.0 / RSS 1.0 + Atom) ──────────────────────────── */

export type ParsedItem = {
  /** guid/id, falling back to link, falling back to title – never empty. */
  guid: string;
  title: string;
  link: string;
  /** Epoch ms; 0 when the feed gives no (parsable) date. */
  publishedMs: number;
};

export type ParsedFeed = {
  title: string;
  items: ParsedItem[];
};

export type ParseError = { error: 'malformed-xml' | 'not-a-feed' | 'no-dom-parser' };

/** First DIRECT child with the given local name – namespace-agnostic. */
function childText(el: Element, tag: string): string {
  for (const child of Array.from(el.children)) {
    if (child.localName === tag) return (child.textContent ?? '').trim();
  }
  return '';
}

function parseDateMs(raw: string): number {
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? 0 : ms;
}

function parseRssItem(item: Element): ParsedItem | null {
  const title = childText(item, 'title');
  const link = childText(item, 'link');
  const guid = childText(item, 'guid') || link || title;
  if (!guid) return null; // nothing stable to key on – skip the item
  return {
    guid,
    title: title || link,
    link,
    publishedMs: parseDateMs(childText(item, 'pubDate') || childText(item, 'date')),
  };
}

function atomLink(entry: Element): string {
  let first = '';
  for (const child of Array.from(entry.children)) {
    if (child.localName !== 'link') continue;
    const href = (child.getAttribute('href') ?? '').trim();
    if (!href) continue;
    const rel = child.getAttribute('rel');
    if (rel === 'alternate' || rel === null || rel === '') return href;
    if (!first) first = href;
  }
  return first;
}

function parseAtomEntry(entry: Element): ParsedItem | null {
  const title = childText(entry, 'title');
  const link = atomLink(entry);
  const guid = childText(entry, 'id') || link || title;
  if (!guid) return null;
  return {
    guid,
    title: title || link,
    link,
    publishedMs: parseDateMs(childText(entry, 'published') || childText(entry, 'updated')),
  };
}

/**
 * Parses an RSS 2.0/1.0 or Atom document. Tolerates missing per-item
 * fields (guid falls back to link, then title); a malformed document or
 * a non-feed XML returns an `{error}` object – it never throws.
 */
export function parseFeed(xml: string): ParsedFeed | ParseError {
  if (typeof DOMParser === 'undefined') return { error: 'no-dom-parser' };
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return { error: 'malformed-xml' };
  const root = doc.documentElement;
  if (!root) return { error: 'malformed-xml' };
  const rootName = root.localName.toLowerCase();

  if (rootName === 'rss' || rootName === 'rdf') {
    // RSS 2.0: <rss><channel><title/><item/>… – RSS 1.0 (RDF) keeps items
    // outside the channel, so collect <item> across the whole document.
    let channelTitle = '';
    for (const child of Array.from(root.children)) {
      if (child.localName === 'channel') {
        channelTitle = childText(child, 'title');
        break;
      }
    }
    const items: ParsedItem[] = [];
    for (const item of Array.from(root.getElementsByTagName('item'))) {
      const parsed = parseRssItem(item);
      if (parsed) items.push(parsed);
    }
    return { title: channelTitle, items };
  }

  if (rootName === 'feed') {
    const items: ParsedItem[] = [];
    for (const entry of Array.from(root.getElementsByTagName('entry'))) {
      const parsed = parseAtomEntry(entry);
      if (parsed) items.push(parsed);
    }
    return { title: childText(root, 'title'), items };
  }

  return { error: 'not-a-feed' };
}

export function isParseError(parsed: ParsedFeed | ParseError): parsed is ParseError {
  return 'error' in parsed;
}

/* ── URL validation ───────────────────────────────────────────────────── */

/** http/https only; returns the normalized URL string or null. */
export function validateFeedUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/* ── Item bookkeeping ─────────────────────────────────────────────────── */

/** Newest first; ties break alphabetically so the order is deterministic. */
export function sortItems<T extends { publishedMs: number; title: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.publishedMs - a.publishedMs || a.title.localeCompare(b.title));
}

export function unreadCount(items: ReadonlyArray<{ read: boolean }>): number {
  return items.reduce((n, item) => n + (item.read ? 0 : 1), 0);
}

/** Splits into the `cap` newest items to keep and the oldest to drop. */
export function pruneOldest<T extends { publishedMs: number; title: string }>(
  items: T[],
  cap: number,
): { keep: T[]; drop: T[] } {
  const sorted = sortItems(items);
  const safeCap = Math.max(0, cap);
  return { keep: sorted.slice(0, safeCap), drop: sorted.slice(safeCap) };
}

/* ── Assistant context ────────────────────────────────────────────────── */

/** One-paragraph summary: unread counts per feed, honest about broken ones. */
export function buildRssContext(feeds: FeedDoc[], items: ItemDoc[], lang: string): string {
  const de = lang.startsWith('de');
  if (feeds.length === 0) return de ? 'Keine Feeds abonniert.' : 'No feeds subscribed.';
  const totalUnread = unreadCount(items);
  const perFeed = feeds
    .map((feed) => {
      const n = unreadCount(items.filter((item) => item.feedId === feed.id));
      const broken = feed.broken ? (de ? ', nicht erreichbar' : ', unreachable') : '';
      return de
        ? `«${feed.title}»: ${n} ungelesen${broken}`
        : `"${feed.title}": ${n} unread${broken}`;
    })
    .join('; ');
  const head = de
    ? `${feeds.length} Feeds, ${totalUnread} ungelesene Artikel.`
    : `${feeds.length} feeds, ${totalUnread} unread articles.`;
  return `${head} ${perFeed}.`;
}
