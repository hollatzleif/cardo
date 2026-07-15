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

/**
 * The next countdown that has not passed yet: the one with the smallest
 * non-negative day distance. Null when the list is empty or everything
 * lies in the past. Powers the "big" and "ring" widget variants, which
 * show exactly one countdown.
 */
export function pickUpcoming<T extends { targetDate: string }>(
  docs: readonly T[],
  now: Date,
): T | null {
  let best: T | null = null;
  let bestDays = Number.POSITIVE_INFINITY;
  for (const doc of docs) {
    const days = daysUntil(doc.targetDate, now);
    if (days >= 0 && days < bestDays) {
      best = doc;
      bestDays = days;
    }
  }
  return best;
}

/**
 * Elapsed fraction (0..1) of the span createdAt → target date, for the
 * "ring" variant's progress ring. Graceful fallbacks: a missing/unparsable
 * createdAt or a non-positive total span yields 1 (a full ring) – honest
 * about "no measurable progress" without ever breaking the render.
 */
export function ringProgress(
  createdAt: string | undefined,
  targetDate: string,
  now: Date,
): number {
  if (!createdAt) return 1;
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return 1;
  const [year, month, day] = targetDate.split('-').map(Number);
  const target = new Date(year ?? 0, (month ?? 1) - 1, day ?? 1).getTime();
  const total = target - created;
  if (total <= 0) return 1;
  const elapsed = now.getTime() - created;
  return Math.min(1, Math.max(0, elapsed / total));
}
