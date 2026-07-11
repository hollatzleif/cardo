/** Shared pure helpers + doc types for the routine tool. */

/** A checklist item, stored as doc `item:<id>` (id duplicated inside the body). */
export type ItemDoc = { id: string; title: string; order: number };

/** Check state of one calendar day, stored as doc `day:<YYYY-MM-DD>`. */
export type DayDoc = { id: string; date: string; checked: string[] };

/**
 * Calendar day of `now` in LOCAL time (not UTC!) as 'YYYY-MM-DD'.
 * Used as the storage key for the per-day check state – each day keys its
 * own doc, so the checklist "resets" at local midnight without deleting data.
 */
export function localDateKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
