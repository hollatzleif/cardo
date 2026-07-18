/**
 * Pure, unit-testable logic for the legal-paragraphs tool. A jurist stores
 * statute sections (§§ / articles) with their own comment. Two acquisition
 * modes share one document shape: "offline" (typed in by hand) and "online"
 * (fetched from a legal source, added in a later step). The online fields
 * exist now so adapters slot in without a migration.
 */

import { z } from 'zod';

export type ParagraphDoc = {
  id: string;
  type: 'paragraph';
  /** e.g. "DE", "EU", "UK" – or free text when entered offline. */
  jurisdiction: string;
  /** Statute book, e.g. "BGB", "GG". */
  book: string;
  /** The section itself, e.g. "§ 242" or "Art. 5". */
  norm: string;
  /** Sub-section / paragraph, e.g. "Abs. 1" (optional). */
  section: string;
  /** Short heading (optional). */
  title: string;
  /** The statute text. */
  text: string;
  /** The user's own comment/annotation. */
  comment: string;
  mode: 'offline' | 'online';
  /** Date the text is current as of (yyyy-mm-dd; empty offline). */
  stand: string;
  /** Source URL (online only). */
  sourceUrl: string;
  /** Change-detection hash of `text` (for the online "check status" action). */
  textHash: string;
  /** Online re-fetch coordinates (empty offline). */
  sourceId: string;
  bookId: string;
  normId: string;
  createdAt: string;
};

export const addParagraphSchema = z.object({
  jurisdiction: z.string().default(''),
  book: z.string().min(1),
  norm: z.string().min(1),
  section: z.string().default(''),
  title: z.string().default(''),
  text: z.string().default(''),
  comment: z.string().default(''),
});
export type AddParagraphInput = z.infer<typeof addParagraphSchema>;

export function makeId(): string {
  return `para:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Small, stable non-cryptographic hash (djb2) for change detection. */
export function textHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

export interface OnlineMeta {
  stand?: string;
  sourceUrl?: string;
  sourceId?: string;
  bookId?: string;
  normId?: string;
}

export function makeParagraph(
  input: AddParagraphInput,
  now: Date = new Date(),
  mode: 'offline' | 'online' = 'offline',
  extra?: OnlineMeta,
): ParagraphDoc {
  const text = input.text.trim();
  return {
    id: makeId(),
    type: 'paragraph',
    jurisdiction: input.jurisdiction.trim(),
    book: input.book.trim(),
    norm: input.norm.trim(),
    section: input.section.trim(),
    title: input.title.trim(),
    text,
    comment: input.comment.trim(),
    mode,
    stand: extra?.stand ?? '',
    sourceUrl: extra?.sourceUrl ?? '',
    textHash: textHash(text),
    sourceId: extra?.sourceId ?? '',
    bookId: extra?.bookId ?? '',
    normId: extra?.normId ?? '',
    createdAt: now.toISOString(),
  };
}

/** Human label, e.g. "BGB § 242 Abs. 1". */
export function paragraphLabel(p: Pick<ParagraphDoc, 'book' | 'norm' | 'section'>): string {
  return [p.book, p.norm, p.section].map((s) => s.trim()).filter(Boolean).join(' ');
}

/** Case-insensitive search across all fields; sorted by label then age. */
export function searchParagraphs(list: ParagraphDoc[], query: string): ParagraphDoc[] {
  const sorted = [...list].sort(
    (a, b) => paragraphLabel(a).localeCompare(paragraphLabel(b)) || a.createdAt.localeCompare(b.createdAt),
  );
  const q = query.trim().toLowerCase();
  if (!q) return sorted;
  return sorted.filter((p) =>
    [p.jurisdiction, p.book, p.norm, p.section, p.title, p.text, p.comment]
      .join(' ')
      .toLowerCase()
      .includes(q),
  );
}

/** Compact snapshot for the assistant's "current state" context. */
export function buildContext(list: ParagraphDoc[], language: string): string {
  const de = language !== 'en';
  if (list.length === 0) return de ? 'Noch keine Paragrafen gespeichert.' : 'No statutes saved yet.';
  const books = [...new Set(list.map((p) => p.book).filter(Boolean))];
  const head = de
    ? `${list.length} Paragrafen aus ${books.length} Gesetzbüchern.`
    : `${list.length} statutes from ${books.length} books.`;
  const sample = list
    .slice(0, 5)
    .map((p) => paragraphLabel(p))
    .filter(Boolean)
    .join(', ');
  return sample ? `${head} ${de ? 'z. B.' : 'e.g.'} ${sample}.` : head;
}
