/**
 * Pure helpers for the stats tool – no React, no storage, no host APIs.
 * Kept side-effect free so they can be unit-tested in a plain node environment.
 */

export type WindowKind = 'day' | 'week' | 'month';

/** Ordered list of the selectable windows (drives the widget's switcher). */
export const WINDOWS: readonly WindowKind[] = ['day', 'week', 'month'];

/**
 * One aggregate document per calendar day, stored under "day:<YYYY-MM-DD>".
 * The id is duplicated INSIDE the doc because storage.query() returns doc
 * bodies without their ids – we need it to write the doc back after a query.
 */
export type DayDoc = {
  id: string;
  /** Local calendar day, "YYYY-MM-DD". */
  date: string;
  /** Tasks completed on this day (from 'todo:completed'). */
  tasksCompleted: number;
  /** Accumulated work seconds (from 'workclock:session-ended'). */
  workSeconds: number;
  /** Finished pomodoro WORK phases (from 'pomodoro:finished'). */
  pomodoros: number;
};

export type Totals = {
  tasksCompleted: number;
  workSeconds: number;
  pomodoros: number;
};

/** The cross-tool events the stats tool aggregates, in normalized form. */
export type StatsEvent =
  | { type: 'todo:completed' }
  | { type: 'workclock:session-ended'; seconds: number }
  | { type: 'pomodoro:finished'; phase: string };

/** Storage id for a day aggregate document. */
export function dayDocId(dateKey: string): string {
  return `day:${dateKey}`;
}

/** A fresh all-zero aggregate for a day. */
export function emptyDay(dateKey: string): DayDoc {
  return { id: dayDocId(dateKey), date: dateKey, tasksCompleted: 0, workSeconds: 0, pomodoros: 0 };
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
 * Applies one incoming event to a day aggregate. Pure: returns a NEW doc,
 * never mutates the input. Only pomodoro WORK phases count as a pomodoro;
 * break phases pass through unchanged.
 */
export function applyEvent(doc: DayDoc, event: StatsEvent): DayDoc {
  switch (event.type) {
    case 'todo:completed':
      return { ...doc, tasksCompleted: doc.tasksCompleted + 1 };
    case 'workclock:session-ended': {
      const seconds = Number.isFinite(event.seconds) ? Math.max(0, Math.floor(event.seconds)) : 0;
      return { ...doc, workSeconds: doc.workSeconds + seconds };
    }
    case 'pomodoro:finished':
      return event.phase === 'work' ? { ...doc, pomodoros: doc.pomodoros + 1 } : doc;
  }
}

/**
 * The LOCAL day keys covered by a window, oldest first, ending with today:
 * day → [today] · week → last 7 days · month → last 30 days.
 * Days are stepped via the Date constructor (not fixed 24h offsets) so
 * month boundaries and DST transitions are handled by the platform.
 */
export function rangeKeys(window: WindowKind, now: Date): string[] {
  const days = window === 'day' ? 1 : window === 'week' ? 7 : 30;
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    keys.push(localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  }
  return keys;
}

/**
 * The LOCAL day keys of the last `weeks` full weeks, oldest first, ending
 * with today – `weeks * 7` keys. Powers the "heatmap" widget variant
 * (12 weeks → 84 cells, rendered column-major as a 7×12 grid).
 */
export function heatmapKeys(weeks: number, now: Date): string[] {
  const days = Math.max(1, Math.floor(weeks)) * 7;
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    keys.push(localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  }
  return keys;
}

/**
 * Maps a day's completed-task count onto 4 accent-intensity steps (plus 0
 * for "nothing happened"), relative to the busiest day in the window.
 * Rendered via color-mix of the accent token – colors stay theme-driven.
 */
export function heatStep(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || max <= 0) return 0;
  const ratio = count / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

/** Sums a set of day aggregates into window totals. */
export function sumDays(days: readonly DayDoc[]): Totals {
  return days.reduce<Totals>(
    (acc, d) => ({
      tasksCompleted: acc.tasksCompleted + d.tasksCompleted,
      workSeconds: acc.workSeconds + d.workSeconds,
      pomodoros: acc.pomodoros + d.pomodoros,
    }),
    { tasksCompleted: 0, workSeconds: 0, pomodoros: 0 },
  );
}

/**
 * Formats seconds as decimal hours, "3.5 h" style: one decimal place,
 * trailing ".0" dropped. Negative input is clamped to "0 h".
 */
export function formatHours(totalSeconds: number): string {
  const hours = Math.max(0, totalSeconds) / 3600;
  const rounded = Math.round(hours * 10) / 10;
  return `${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)} h`;
}
