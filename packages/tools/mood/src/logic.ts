/**
 * Pure, storage-free logic for the mood tool.
 * Kept separate from index.tsx so it can be unit-tested in a plain node
 * environment (no React, no DOM, no host).
 */

import { z } from 'zod';

/* ── Docs / params ────────────────────────────────────────────────────── */

/** One mood entry per LOCAL day ("day:<yyyy-mm-dd>"). */
export type MoodDayDoc = {
  id: string;
  type: 'day';
  /** yyyy-mm-dd, LOCAL calendar date. */
  date: string;
  /** 1 (awful) … 5 (great). */
  mood: number;
  /** Optional one-line journal note. */
  note?: string;
};

export type WeekStart = 'mon' | 'sun';
export type ScaleStyle = 'emoji' | 'numbers';

export const MOODS = [1, 2, 3, 4, 5] as const;

/** Mood 1…5 → emoji, index-safe. */
const MOOD_EMOJI = ['😞', '😕', '😐', '🙂', '😄'] as const;

export const logMoodParamsSchema = z.object({
  mood: z.number().int().min(1).max(5),
  note: z.string().optional(),
});
export type LogMoodParams = z.infer<typeof logMoodParamsSchema>;

/* ── Dates (LOCAL day keys; arithmetic runs in UTC on the key → no drift) ── */

/** Local calendar date as yyyy-mm-dd (00:30 local is still "today"). */
export function localDayKey(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

/** day key + days, as yyyy-mm-dd (pure string math via UTC – timezone-proof). */
export function addDays(date: string, days: number): string {
  const ms = new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

export function makeDayDoc(date: string, mood: number, note?: string): MoodDayDoc {
  const doc: MoodDayDoc = { id: `day:${date}`, type: 'day', date, mood };
  const trimmed = note?.trim();
  if (trimmed) doc.note = trimmed;
  return doc;
}

/* ── Streak / averages ────────────────────────────────────────────────── */

/**
 * Consecutive logged days ending today – or ending yesterday when today has
 * not been logged yet (an unfinished today must not kill the streak).
 */
export function streak(entries: Array<Pick<MoodDayDoc, 'date'>>, today: string): number {
  const dates = new Set(entries.map((e) => e.date));
  let cursor = dates.has(today) ? today : addDays(today, -1);
  let count = 0;
  while (dates.has(cursor)) {
    count += 1;
    cursor = addDays(cursor, -1);
  }
  return count;
}

/**
 * Average mood of the last `days` days ending at `today` (inclusive).
 * Only logged days count; null when the window holds no entries.
 */
export function averageMood(
  entries: Array<Pick<MoodDayDoc, 'date' | 'mood'>>,
  days: number,
  today: string,
): number | null {
  const from = addDays(today, -(days - 1));
  const window = entries.filter((e) => e.date >= from && e.date <= today);
  if (window.length === 0) return null;
  return window.reduce((acc, e) => acc + e.mood, 0) / window.length;
}

/** Chronological mood series of the last `days` days (null = not logged). */
export function moodSeries(
  entries: Array<Pick<MoodDayDoc, 'date' | 'mood'>>,
  days: number,
  today: string,
): Array<{ date: string; mood: number | null }> {
  const byDate = new Map(entries.map((e) => [e.date, e.mood]));
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(today, i - (days - 1));
    return { date, mood: byDate.get(date) ?? null };
  });
}

/* ── Calendar matrix ──────────────────────────────────────────────────── */

/**
 * Month grid for the calendar variant: full weeks of 7 cells, each cell a
 * yyyy-mm-dd day key or null padding. `month` is 1-12.
 */
export function monthMatrix(
  year: number,
  month: number,
  weekStart: WeekStart,
): Array<Array<string | null>> {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  // getUTCDay(): 0 = Sunday … 6 = Saturday → offset inside the first week.
  const lead =
    weekStart === 'mon' ? (first.getUTCDay() + 6) % 7 : first.getUTCDay();
  const cells: Array<string | null> = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => {
      const d = String(i + 1).padStart(2, '0');
      return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${d}`;
    }),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: Array<Array<string | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/* ── Presentation helpers (token names only – never raw colors) ───────── */

/** Mood 1…5 → chart token CSS var (clamped, so bad data cannot break CSS). */
export function moodToken(mood: number): string {
  const m = Math.min(5, Math.max(1, Math.round(mood)));
  return `var(--chart-${m})`;
}

export function moodEmoji(mood: number): string {
  const m = Math.min(5, Math.max(1, Math.round(mood)));
  return MOOD_EMOJI[m - 1] ?? '😐';
}

/* ── Assistant context ────────────────────────────────────────────────── */

/**
 * Compact snapshot for the assistant's "current state" context:
 * today's mood (if logged), the streak and the 7-day average.
 */
export function buildMoodContext(
  entries: MoodDayDoc[],
  language: string,
  today: string,
): string {
  const de = language === 'de';
  if (entries.length === 0) {
    return de ? 'Noch keine Stimmung eingetragen.' : 'No mood entries yet.';
  }
  const todayEntry = entries.find((e) => e.date === today);
  const head = todayEntry
    ? de
      ? `Heutige Stimmung: ${todayEntry.mood}/5 ${moodEmoji(todayEntry.mood)}${todayEntry.note ? ` („${todayEntry.note}“)` : ''}.`
      : `Today's mood: ${todayEntry.mood}/5 ${moodEmoji(todayEntry.mood)}${todayEntry.note ? ` ("${todayEntry.note}")` : ''}.`
    : de
      ? 'Heute ist noch keine Stimmung eingetragen.'
      : 'No mood logged today yet.';
  const s = streak(entries, today);
  const streakText = de ? `Serie: ${s} Tag(e).` : `Streak: ${s} day(s).`;
  const avg = averageMood(entries, 7, today);
  const avgText =
    avg === null
      ? de
        ? 'Keine Einträge in den letzten 7 Tagen.'
        : 'No entries in the last 7 days.'
      : de
        ? `7-Tage-Schnitt: ${avg.toFixed(1)}/5.`
        : `7-day average: ${avg.toFixed(1)}/5.`;
  return `${head} ${streakText} ${avgText}`;
}
