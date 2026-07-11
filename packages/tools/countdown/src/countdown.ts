/**
 * Pure countdown logic – no host access, fully unit-testable.
 */

/**
 * Calendar-day difference between `now` and a target date "YYYY-MM-DD",
 * both interpreted in LOCAL time (midnight to midnight – not raw 24h
 * buckets). Same day → 0, tomorrow → 1, yesterday → -1.
 * Math.round absorbs DST-shifted days (23h/25h).
 */
export function daysUntil(targetDate: string, now: Date): number {
  const [year, month, day] = targetDate.split('-').map(Number);
  const target = new Date(year ?? 0, (month ?? 1) - 1, day ?? 1);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((target.getTime() - start.getTime()) / msPerDay);
}
