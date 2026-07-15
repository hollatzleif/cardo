/**
 * Pure, storage-free logic for the time-blocking tool.
 * Kept separate from index.tsx so it can be unit-tested in a plain node
 * environment (no React, no DOM, no host).
 *
 * All time math works on LOCAL "HH:MM" strings and minutes since midnight –
 * deliberately NO Date arithmetic inside a day, so DST never shifts a block.
 */

import { z } from 'zod';

export type Block = {
  /** Stable id, unique within its day doc. */
  id: string;
  /** "HH:MM", local time. */
  start: string;
  /** "HH:MM", local time – must be after start. */
  end: string;
  title: string;
  category?: string;
};

/** One planned day, stored as `day:<YYYY-MM-DD>`. */
export type DayDoc = {
  type: 'day';
  /** The day this doc belongs to, YYYY-MM-DD (same as the key suffix). */
  date: string;
  blocks: Block[];
};

export const SLOT_MINUTES = [15, 30, 60] as const;
export type SlotMinutes = (typeof SLOT_MINUTES)[number];

export const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Params of the time-blocking.add-block command. */
export const addBlockParamsSchema = z.object({
  date: z.string().regex(DATE_RE).optional(),
  start: z.string().regex(HHMM_RE),
  end: z.string().regex(HHMM_RE),
  title: z.string().min(1),
  category: z.string().optional(),
});
export type AddBlockParams = z.infer<typeof addBlockParamsSchema>;

export function isValidHhmm(value: string): boolean {
  return HHMM_RE.test(value);
}

/** YYYY-MM-DD and actually a real calendar date (rejects e.g. 2026-13-40). */
export function isValidDateKey(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === date;
}

/** "HH:MM" → minutes since local midnight. Invalid input → 0. */
export function toMinutes(hhmm: string): number {
  if (!isValidHhmm(hhmm)) return 0;
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/** Minutes since midnight → "HH:MM" (clamped into 00:00–23:59). */
export function toHhmm(minutes: number): string {
  const clamped = Math.min(Math.max(Math.round(minutes), 0), 24 * 60 - 1);
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Snap an "HH:MM" time to the nearest grid slot (15/30/60 minutes).
 * Rounds to the NEAREST slot; results past the last representable slot of
 * the day clamp DOWN (23:59 @60 → 23:00), so output is always valid HH:MM.
 * Invalid input is returned unchanged.
 */
export function snapToGrid(hhmm: string, minutes: number): string {
  if (!isValidHhmm(hhmm) || !Number.isFinite(minutes) || minutes <= 0) return hhmm;
  const step = Math.round(minutes);
  const snapped = Math.round(toMinutes(hhmm) / step) * step;
  const lastSlot = Math.floor((24 * 60 - 1) / step) * step;
  return toHhmm(Math.min(snapped, lastSlot));
}

/** Duration of a block in minutes; end at or before start → 0 (never negative). */
export function blockMinutes(block: Pick<Block, 'start' | 'end'>): number {
  return Math.max(0, toMinutes(block.end) - toMinutes(block.start));
}

/**
 * Whether two blocks overlap in time. Touching edges (a.end === b.start)
 * do NOT overlap; zero-length blocks never overlap anything.
 */
export function overlaps(
  a: Pick<Block, 'start' | 'end'>,
  b: Pick<Block, 'start' | 'end'>,
): boolean {
  const aStart = toMinutes(a.start);
  const aEnd = toMinutes(a.end);
  const bStart = toMinutes(b.start);
  const bEnd = toMinutes(b.end);
  if (aEnd <= aStart || bEnd <= bStart) return false;
  return aStart < bEnd && bStart < aEnd;
}

/** Ids of every block that overlaps at least one other block of its day. */
export function findConflicts(blocks: Block[]): Set<string> {
  const conflicted = new Set<string>();
  for (let i = 0; i < blocks.length; i += 1) {
    for (let j = i + 1; j < blocks.length; j += 1) {
      const a = blocks[i];
      const b = blocks[j];
      if (a && b && overlaps(a, b)) {
        conflicted.add(a.id);
        conflicted.add(b.id);
      }
    }
  }
  return conflicted;
}

/** Blocks sorted by start, then end, then title (stable, non-mutating). */
export function sortBlocks(blocks: Block[]): Block[] {
  return [...blocks].sort(
    (a, b) =>
      toMinutes(a.start) - toMinutes(b.start) ||
      toMinutes(a.end) - toMinutes(b.end) ||
      a.title.localeCompare(b.title),
  );
}

/**
 * LOCAL calendar date of `date` as YYYY-MM-DD – built from the local
 * getFullYear/getMonth/getDate, so 00:30 local never drifts to the UTC
 * previous/next day.
 */
export function todayKey(date: Date = new Date()): string {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

/** Day key shifted by `days` whole days (local calendar, month/year safe). */
export function shiftDayKey(key: string, days: number): string {
  if (!isValidDateKey(key)) return key;
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  const d = Number(key.slice(8, 10));
  return todayKey(new Date(y, m - 1, d + days, 12, 0, 0));
}

export function makeBlockId(): string {
  return `block:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function makeBlock(input: {
  start: string;
  end: string;
  title: string;
  category?: string;
}): Block {
  const block: Block = {
    id: makeBlockId(),
    start: input.start,
    end: input.end,
    title: input.title.trim(),
  };
  const category = input.category?.trim();
  if (category) block.category = category;
  return block;
}

/** "HH:MM" for display – 24h as-is, 12h as "h:MM AM/PM". */
export function formatTime(hhmm: string, twelveHour: boolean): string {
  if (!twelveHour || !isValidHhmm(hhmm)) return hhmm;
  const total = toMinutes(hhmm);
  const h24 = Math.floor(total / 60);
  const m = total % 60;
  const suffix = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/**
 * Compact snapshot of TODAY's plan for the assistant's "current state"
 * context: block count, planned minutes, the blocks themselves and any
 * conflicts.
 */
export function buildTimeBlockingContext(
  day: DayDoc | null,
  language: string,
  dateKey: string,
): string {
  const de = language === 'de';
  const blocks = sortBlocks(day?.blocks ?? []);
  if (blocks.length === 0) {
    return de
      ? `Für heute (${dateKey}) sind keine Zeitblöcke geplant.`
      : `No time blocks planned for today (${dateKey}).`;
  }
  const total = blocks.reduce((acc, b) => acc + blockMinutes(b), 0);
  const listed = blocks
    .map((b) => `${b.start}–${b.end} «${b.title}»${b.category ? ` (${b.category})` : ''}`)
    .join(', ');
  const conflicts = findConflicts(blocks);
  const head = de
    ? `${blocks.length} Zeitblöcke heute (${dateKey}), insgesamt ${total} Minuten geplant: ${listed}.`
    : `${blocks.length} time blocks today (${dateKey}), ${total} minutes planned in total: ${listed}.`;
  if (conflicts.size === 0) return head;
  const conflictTitles = blocks
    .filter((b) => conflicts.has(b.id))
    .map((b) => `«${b.title}»`)
    .join(', ');
  const tail = de
    ? ` Achtung, Überschneidungen: ${conflictTitles}.`
    : ` Warning, overlapping blocks: ${conflictTitles}.`;
  return head + tail;
}
