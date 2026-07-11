/**
 * Pure alarm logic – no host access, fully unit-testable.
 */

/**
 * Next occurrence of a wall-clock time ("HH:MM") relative to `now`,
 * in local time. If the time is still ahead today the result is today,
 * otherwise (already passed or exactly now) it is tomorrow.
 */
export function nextOccurrence(time: string, now: Date): Date {
  const [hours, minutes] = time.split(':').map(Number);
  const next = new Date(now);
  next.setHours(hours ?? 0, minutes ?? 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}
