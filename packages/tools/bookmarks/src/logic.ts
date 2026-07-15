/**
 * Pure, storage-free logic for the Bookmarks tool.
 * Kept separate from index.tsx so it can be unit-tested in a plain node
 * environment (no React, no DOM, no host).
 */

export type LinkDoc = {
  /**
   * Stable id, identical to the storage doc id. query() returns doc bodies
   * WITHOUT their ids, so the id always lives inside the doc as well.
   */
  id: string;
  type: 'link';
  /** Validated, normalized http(s) URL – validateUrl() is the only producer. */
  url: string;
  title: string;
  /** Folder name; '' = unfiled. */
  folder: string;
  createdAt: string;
};

/** Chart token for tinting a folder's tiles – shape matches the theme tokens. */
export type FolderToken =
  | 'chart-1'
  | 'chart-2'
  | 'chart-3'
  | 'chart-4'
  | 'chart-5'
  | 'chart-6'
  | 'chart-7'
  | 'chart-8';

export function makeId(): string {
  return `link:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Matches an explicit URL scheme prefix like "https:", "javascript:", "data:". */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Security gate for every stored URL: ONLY http/https survive – javascript:,
 * data:, file: and friends are rejected. Scheme-less input ("example.com")
 * is upgraded to https. Returns the normalized href or null.
 * Note: "localhost:3000" without a scheme parses as scheme "localhost:" and
 * is therefore rejected – use "http://localhost:3000".
 */
export function validateUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidate = SCHEME_RE.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname;
  if (!host) return null;
  // Require a real-looking host: a dot somewhere, or localhost.
  if (!host.includes('.') && host !== 'localhost') return null;
  return url.href;
}

export function makeLink(
  input: { url: string; title: string; folder?: string },
  now: Date = new Date(),
): LinkDoc {
  return {
    id: makeId(),
    type: 'link',
    url: input.url,
    title: input.title.trim(),
    folder: input.folder?.trim() ?? '',
    createdAt: now.toISOString(),
  };
}

/** Display domain of a validated URL: hostname (port stripped), no "www.". */
export function domainOf(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return '';
  }
  return host.startsWith('www.') ? host.slice(4) : host;
}

/** First grapheme of the title, uppercased – the letter-avatar text. */
export function letterAvatar(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return '#';
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(trimmed);
    for (const segment of segments) return segment.segment.toUpperCase();
  }
  const first = Array.from(trimmed)[0];
  return (first ?? '#').toUpperCase();
}

/** Deterministic chart token per folder name, so a folder keeps its tint. */
export function folderToken(folder: string): FolderToken {
  let hash = 0;
  for (let i = 0; i < folder.length; i += 1) {
    hash = (hash * 31 + folder.charCodeAt(i)) >>> 0;
  }
  return `chart-${((hash % 8) + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;
}

/** Title order (case-insensitive), createdAt as deterministic tiebreaker. */
export function sortLinks(links: LinkDoc[]): LinkDoc[] {
  return [...links].sort((a, b) => {
    const ta = a.title.toLowerCase();
    const tb = b.title.toLowerCase();
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });
}

/** Unfiled links ('') first, then folders alphabetically; links title-sorted. */
export function groupByFolder(links: LinkDoc[]): Array<{ folder: string; links: LinkDoc[] }> {
  const buckets = new Map<string, LinkDoc[]>();
  for (const link of links) {
    const bucket = buckets.get(link.folder);
    if (bucket) bucket.push(link);
    else buckets.set(link.folder, [link]);
  }
  return [...buckets.keys()]
    .sort((a, b) => {
      if (a === b) return 0;
      if (a === '') return -1;
      if (b === '') return 1;
      return a.toLowerCase() < b.toLowerCase() ? -1 : 1;
    })
    .map((folder) => ({ folder, links: sortLinks(buckets.get(folder) ?? []) }));
}

/** The n most recently added links – the speed-dial selection. */
export function topLinks(links: LinkDoc[], n = 8): LinkDoc[] {
  return [...links]
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, n);
}

/**
 * Compact snapshot of the link collection for the assistant's "current state"
 * context, so it can spot duplicates and reuse folder names. Grouped by
 * folder, capped for prompt size.
 */
export function buildBookmarksContext(links: LinkDoc[], language: string): string {
  const de = language === 'de';
  if (links.length === 0) {
    return de ? 'Keine Lesezeichen gespeichert.' : 'No bookmarks saved.';
  }
  const unfiled = de ? 'Ohne Ordner' : 'Unfiled';
  const parts = groupByFolder(links).map(({ folder, links: bucket }) => {
    const labels = bucket
      .slice(0, 12)
      .map((link) => `«${link.title}» (${domainOf(link.url)})`);
    return `${folder === '' ? unfiled : folder}: ${labels.join(', ')}`;
  });
  const heading = de
    ? `${links.length} Lesezeichen`
    : `${links.length} bookmark${links.length === 1 ? '' : 's'}`;
  return `${heading} – ${parts.join('. ')}.`;
}
