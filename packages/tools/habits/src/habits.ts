/** Shared pure helpers + doc types for the habits tool. */

/** One habit, stored as doc `habit:<id>` (id duplicated inside the body). */
export type HabitDoc = { id: string; title: string; order: number; createdAt: string };

/**
 * Completions of one calendar day, stored as doc `day:<YYYY-MM-DD>`.
 * `done` holds the ids of the habits checked off on that (local) day.
 */
export type DayDoc = { id: string; date: string; done: string[] };

/**
 * Calendar day of `now` in LOCAL time (not UTC!) as 'YYYY-MM-DD'.
 * Used as the storage key for the per-day completions – a habit checked at
 * 23:59 belongs to the day the user experienced, not to the UTC day.
 */
export function localDateKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Parse a 'YYYY-MM-DD' key as a LOCAL date (noon, to be safe around DST). */
export function dateFromKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12, 0, 0, 0);
}

/** The date key `delta` calendar days away from `key` (local calendar). */
export function addDays(key: string, delta: number): string {
  const date = dateFromKey(key);
  date.setDate(date.getDate() + delta);
  return localDateKey(date);
}

/**
 * Current streak in days, ending "now": consecutive done-days up to today.
 * Today counts if it is checked; otherwise the streak is still alive and
 * counted up to yesterday (the user simply hasn't checked in yet).
 */
export function currentStreak(doneDates: Iterable<string>, todayKey: string): number {
  const done = new Set(doneDates);
  let cursor = done.has(todayKey) ? todayKey : addDays(todayKey, -1);
  let streak = 0;
  while (done.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/** Longest run of consecutive done-days anywhere in history. */
export function longestStreak(doneDates: Iterable<string>): number {
  const done = new Set(doneDates);
  let best = 0;
  for (const key of done) {
    if (done.has(addDays(key, -1))) continue; // only start counting at run starts
    let length = 1;
    let cursor = addDays(key, 1);
    while (done.has(cursor)) {
      length += 1;
      cursor = addDays(cursor, 1);
    }
    best = Math.max(best, length);
  }
  return best;
}

export const HEATMAP_WEEKS = 26;
export const HEATMAP_DAYS = HEATMAP_WEEKS * 7; // 182 cells → 7 rows × 26 columns

/**
 * The date keys of the last 26 weeks, oldest first, ending at `todayKey`.
 * Rendered column-major (grid-auto-flow: column) this fills a 7×26 grid
 * where each column is one week ending in the current one.
 */
export function heatmapDays(todayKey: string): string[] {
  const days: string[] = [];
  for (let i = HEATMAP_DAYS - 1; i >= 0; i -= 1) {
    days.push(addDays(todayKey, -i));
  }
  return days;
}

/**
 * Completion ratio (0..1) → one of 5 discrete heat levels.
 * 0 = nothing done · 1–4 = quarter steps, rendered as opacity level × 0.25
 * of a single chart token (colors stay 100% theme-driven).
 */
export function heatLevel(ratio: number): 0 | 1 | 2 | 3 | 4 {
  if (ratio <= 0) return 0;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}
