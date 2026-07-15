/**
 * Pure, storage-free logic for the sleep-log tool.
 * Kept separate from index.tsx so it can be unit-tested in a plain node
 * environment (no React, no DOM, no host).
 */

import { z } from 'zod';

/* ── Docs / params ────────────────────────────────────────────────────── */

/** One night per WAKE-UP day ("night:<yyyy-mm-dd>", LOCAL date). */
export type NightDoc = {
  id: string;
  type: 'night';
  /** Wake-up date, yyyy-mm-dd LOCAL. */
  date: string;
  /** Bedtime "HH:MM" (may be before or after midnight). */
  bed: string;
  /** Wake time "HH:MM". */
  wake: string;
};

export type TimeFormat = '24' | '12';

export const DEFAULT_GOAL_HOURS = 8;
export const MIN_GOAL_HOURS = 5;
export const MAX_GOAL_HOURS = 12;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const logNightParamsSchema = z.object({
  bed: z.string().regex(HHMM),
  wake: z.string().regex(HHMM),
  /** Wake-up date; defaults to today (LOCAL). */
  date: z.string().regex(ISO_DATE).optional(),
});
export type LogNightParams = z.infer<typeof logNightParamsSchema>;

export function isValidTime(time: string): boolean {
  return HHMM.test(time);
}

/** yyyy-mm-dd and actually a real calendar date (rejects e.g. 2026-02-30). */
export function isValidDate(date: string): boolean {
  if (!ISO_DATE.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === date;
}

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

export function makeNight(date: string, bed: string, wake: string): NightDoc {
  return { id: `night:${date}`, type: 'night', date, bed, wake };
}

/* ── Duration math ────────────────────────────────────────────────────── */

function toMinutes(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

/**
 * Sleep duration in minutes. Definition: bed == wake → 0; when the bedtime
 * is later in the day than the wake time, the night crosses midnight
 * (23:30 → 07:15 = 465); otherwise both lie on the wake-up day
 * (01:00 → 08:00 = 420). Invalid times yield 0.
 */
export function durationMinutes(bed: string, wake: string): number {
  if (!isValidTime(bed) || !isValidTime(wake)) return 0;
  const b = toMinutes(bed);
  const w = toMinutes(wake);
  if (b === w) return 0;
  return b < w ? w - b : 24 * 60 - b + w;
}

export function averageMinutes(durations: number[]): number {
  if (durations.length === 0) return 0;
  return durations.reduce((acc, d) => acc + d, 0) / durations.length;
}

/** Population standard deviation of the durations (0 for 0-1 entries). */
export function consistencyStdev(durations: number[]): number {
  if (durations.length <= 1) return 0;
  const mean = averageMinutes(durations);
  const variance =
    durations.reduce((acc, d) => acc + (d - mean) * (d - mean), 0) / durations.length;
  return Math.sqrt(variance);
}

/** Minutes over (+) or under (−) the goal. */
export function goalDelta(minutes: number, goalHours: number): number {
  return minutes - goalHours * 60;
}

/**
 * Consecutive nights meeting the goal, ending at `today` – or ending
 * yesterday when tonight has not been logged yet.
 */
export function goalStreak(nights: NightDoc[], goalMinutes: number, today: string): number {
  const met = new Set(
    nights.filter((n) => durationMinutes(n.bed, n.wake) >= goalMinutes).map((n) => n.date),
  );
  let cursor = met.has(today) ? today : addDays(today, -1);
  let count = 0;
  while (met.has(cursor)) {
    count += 1;
    cursor = addDays(cursor, -1);
  }
  return count;
}

/* ── Formatting ───────────────────────────────────────────────────────── */

/** "7 h 45 min" – whole-hour values drop the minutes, sub-hour values the hours. */
export function formatHm(minutes: number): string {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

/** "23:30" → "11:30 PM" in 12h mode; 24h mode passes through. */
export function formatClock(time: string, format: TimeFormat): string {
  if (format === '24' || !isValidTime(time)) return time;
  const h = Number(time.slice(0, 2));
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${time.slice(3, 5)} ${suffix}`;
}

/** The last `count` nights, newest first. */
export function lastNights(nights: NightDoc[], count: number): NightDoc[] {
  return [...nights].sort((a, b) => b.date.localeCompare(a.date)).slice(0, count);
}

/** One bar per day for the last 7 days ending at `today` (oldest first). */
export function weekSeries(
  nights: NightDoc[],
  today: string,
): Array<{ date: string; minutes: number | null }> {
  const byDate = new Map(nights.map((n) => [n.date, durationMinutes(n.bed, n.wake)]));
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(today, i - 6);
    return { date, minutes: byDate.get(date) ?? null };
  });
}

/* ── Assistant context ────────────────────────────────────────────────── */

/**
 * Compact snapshot for the assistant's "current state" context:
 * last night, 7-day average and the goal streak.
 */
export function buildSleepContext(
  nights: NightDoc[],
  language: string,
  today: string,
  goalHours: number,
): string {
  const de = language === 'de';
  if (nights.length === 0) {
    return de ? 'Noch keine Nächte erfasst.' : 'No nights logged yet.';
  }
  const latest = lastNights(nights, 1)[0];
  const head = latest
    ? de
      ? `Letzte Nacht (${latest.date}): ${latest.bed}–${latest.wake}, ${formatHm(durationMinutes(latest.bed, latest.wake))}.`
      : `Last night (${latest.date}): ${latest.bed}–${latest.wake}, ${formatHm(durationMinutes(latest.bed, latest.wake))}.`
    : '';
  const week = weekSeries(nights, today)
    .map((d) => d.minutes)
    .filter((m): m is number => m !== null);
  const avgText =
    week.length > 0
      ? de
        ? `7-Tage-Schnitt: ${formatHm(averageMinutes(week))}.`
        : `7-day average: ${formatHm(averageMinutes(week))}.`
      : de
        ? 'Keine Nächte in den letzten 7 Tagen.'
        : 'No nights in the last 7 days.';
  const s = goalStreak(nights, goalHours * 60, today);
  const goalText = de
    ? `Ziel ${goalHours} h, Serie: ${s} Nacht/Nächte.`
    : `Goal ${goalHours} h, streak: ${s} night(s).`;
  return `${head} ${avgText} ${goalText}`.trim();
}
