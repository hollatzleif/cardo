/**
 * Pure, storage-free logic for the reading-list tool.
 * Kept separate from index.tsx so it can be unit-tested in a plain node
 * environment (no React, no DOM, no host).
 */

export type ReadingStatus = 'queued' | 'reading' | 'done';

export type ReadingItem = {
  /** Stable id, identical to the storage doc id (query() strips doc ids). */
  id: string;
  type: 'item';
  title: string;
  /** Optional source link – validated to http/https by validateUrl(). */
  url?: string;
  status: ReadingStatus;
  /** Free-form personal notes, editable in the widget. */
  notes: string;
  createdAt: string;
};

export const READING_STATUSES: ReadingStatus[] = ['queued', 'reading', 'done'];

/** Currently-reading first, then the queue, finished items last. */
const STATUS_RANK: Record<ReadingStatus, number> = { reading: 0, queued: 1, done: 2 };

export function makeItemId(): string {
  return `item:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function makeItem(
  input: { title: string; url?: string },
  now: Date = new Date(),
): ReadingItem {
  const item: ReadingItem = {
    id: makeItemId(),
    type: 'item',
    title: input.title.trim(),
    status: 'queued',
    notes: '',
    createdAt: now.toISOString(),
  };
  const url = input.url?.trim();
  if (url) item.url = url;
  return item;
}

/**
 * Accepts only http/https links (rejects javascript:, data:, ftp:, …
 * and anything the URL parser refuses). Empty input is NOT a valid url –
 * callers treat the field as optional themselves.
 */
export function validateUrl(raw: string): boolean {
  const url = raw.trim();
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Status order (reading → queued → done), then FIFO by createdAt inside a status. */
export function sortItems(items: ReadingItem[]): ReadingItem[] {
  return [...items].sort((a, b) => {
    const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (byStatus !== 0) return byStatus;
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });
}

export function filterByStatus(items: ReadingItem[], status: ReadingStatus): ReadingItem[] {
  return items.filter((item) => item.status === status);
}

/**
 * File-name slug for "send to notes": lowercase, umlauts transliterated,
 * everything else non-alphanumeric collapsed to single dashes. Never empty,
 * capped so file names stay sane.
 */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'item';
}

/** Markdown body of the note created by the "send to notes" button. */
export function buildNoteMarkdown(item: Pick<ReadingItem, 'title' | 'url' | 'notes'>): string {
  const parts: string[] = [`# ${item.title.replace(/\n+/g, ' ').trim()}`];
  if (item.url) parts.push(`<${item.url}>`);
  const notes = item.notes.trim();
  if (notes) parts.push(notes);
  return `${parts.join('\n\n')}\n`;
}

/**
 * Compact snapshot for the assistant's "current state" context so it can
 * reference existing items instead of re-adding them. Capped for prompt size.
 */
export function buildReadingContext(items: ReadingItem[], language: string): string {
  const de = language === 'de';
  if (items.length === 0) return de ? 'Die Leseliste ist leer.' : 'The reading list is empty.';
  const sorted = sortItems(items);
  const label = (status: ReadingStatus): string => {
    if (status === 'reading') return de ? 'Gerade dabei' : 'Currently reading';
    if (status === 'queued') return de ? 'Vorgemerkt' : 'Queued';
    return de ? 'Fertig' : 'Done';
  };
  const parts: string[] = [];
  const byRank: ReadingStatus[] = ['reading', 'queued', 'done'];
  for (const status of byRank) {
    const titles = filterByStatus(sorted, status)
      .slice(0, 10)
      .map((item) => `«${item.title}»`);
    if (titles.length > 0) parts.push(`${label(status)}: ${titles.join(', ')}.`);
  }
  return parts.join(' ');
}
