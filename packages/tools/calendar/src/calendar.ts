/**
 * Pure calendar logic – no host access, fully unit-testable.
 * All computations use LOCAL time (wall-clock semantics for appointments).
 */

/** Local-time date key "YYYY-MM-DD" for a Date. */
export function dateKey(d: Date): string {
  const y = String(d.getFullYear()).padStart(4, '0');
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse "YYYY-MM-DD" (+ optional "HH:MM") into a LOCAL Date. */
export function eventStart(date: string, time?: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = (time ?? '00:00').split(':').map(Number);
  return new Date(y ?? 0, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0, 0, 0);
}

/** Fire time of a reminder: event start minus reminderMinutes (local). */
export function reminderFireTime(date: string, time: string, reminderMinutes: number): Date {
  return new Date(eventStart(date, time).getTime() - reminderMinutes * 60_000);
}

/**
 * 6×7 grid of LOCAL Dates covering the given month (`month` is 0-based).
 * The first cell is the `weekStartsOn` weekday (0 = Sunday … 6 = Saturday,
 * default 1 = Monday) on or before the 1st of the month.
 */
export function monthGrid(year: number, month: number, weekStartsOn = 1): Date[][] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() - weekStartsOn + 7) % 7;
  const grid: Date[][] = [];
  for (let row = 0; row < 6; row++) {
    const week: Date[] = [];
    for (let col = 0; col < 7; col++) {
      week.push(new Date(year, month, 1 - offset + row * 7 + col));
    }
    grid.push(week);
  }
  return grid;
}

/** Shift a (year, month) pair by delta months. `month` is 0-based. */
export function addMonths(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const total = year * 12 + month + delta;
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 };
}

/**
 * Localized short weekday labels starting at `weekStartsOn`.
 * Uses Intl – never hardcoded day names.
 */
export function weekdayLabels(locale: string, weekStartsOn = 1): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  // 2024-01-07 was a Sunday, so day-of-week n maps to January (7 + n), 2024.
  return Array.from({ length: 7 }, (_, i) =>
    fmt.format(new Date(2024, 0, 7 + ((weekStartsOn + i) % 7))),
  );
}
