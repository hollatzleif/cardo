/**
 * Pure helpers for the workclock tool – no React, no storage, no host APIs.
 * Kept side-effect free so they can be unit-tested in a plain node environment.
 */

/**
 * One document per calendar day, stored under the id "day:<YYYY-MM-DD>".
 * The id is duplicated INSIDE the doc because storage.query() returns doc
 * bodies without their ids – we need it to write the doc back after a query.
 */
export type DayDoc = {
  id: string;
  /** Local calendar day, "YYYY-MM-DD". */
  date: string;
  /** Completed (accumulated) productive seconds for this day. */
  seconds: number;
  /** ISO timestamp while the clock is running, otherwise null/absent. */
  runningSince?: string | null;
};

/** Storage id for a day document. */
export function dayDocId(dateKey: string): string {
  return `day:${dateKey}`;
}

/**
 * "YYYY-MM-DD" for the LOCAL calendar day of `now`.
 * Deliberately NOT toISOString().slice(0, 10) – that would be the UTC day,
 * which differs from the user's day near midnight in any non-UTC timezone.
 */
export function localDateKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Formats a duration in seconds as "H:MM:SS" (one hour or more)
 * or "MM:SS" (under one hour). Negative/fractional input is clamped/floored.
 */
export function formatDuration(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Whole seconds elapsed since an ISO timestamp (never negative). */
export function elapsedSeconds(runningSinceIso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(runningSinceIso)) / 1000));
}
