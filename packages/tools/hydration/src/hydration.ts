/** Shared pure helpers + doc types for the hydration tool. No imports – unit-testable in isolation. */

/** Glass count of one calendar day, stored as doc `day:<YYYY-MM-DD>` (id duplicated inside the body). */
export type DayDoc = { id: string; date: string; glasses: number };

/**
 * Singleton doc `state`: the pending reminder schedule handle and the last
 * day the goal celebration fired (so `hydration:goal-reached` emits once per day).
 */
export type StateDoc = { id: string; scheduleId?: string; celebratedDate?: string };

/**
 * Calendar day of `now` in LOCAL time (not UTC!) as 'YYYY-MM-DD'.
 * Used as the storage key for the per-day glass count – each day keys its
 * own doc, so the counter "resets" at local midnight without deleting data.
 */
export function localDateKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** "HH:MM" → minutes since local midnight, or null for malformed input. */
function parseMinutes(hhmm: string): number | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Is `now` inside the reminder window [from, until] (both inclusive, local
 * wall-clock)? Windows crossing midnight are supported: "22:00"–"06:00"
 * covers late evening AND early morning. `from === until` degenerates to
 * "always" (a 24h window). Malformed times fail OPEN (in-window) so a broken
 * setting silences the window check, never the reminders themselves.
 */
export function isInWindow(now: Date, from: string, until: string): boolean {
  const fromMin = parseMinutes(from);
  const untilMin = parseMinutes(until);
  if (fromMin === null || untilMin === null) return true;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (fromMin === untilMin) return true;
  if (fromMin < untilMin) return nowMin >= fromMin && nowMin <= untilMin;
  // Window crosses midnight, e.g. 22:00–06:00.
  return nowMin >= fromMin || nowMin <= untilMin;
}
