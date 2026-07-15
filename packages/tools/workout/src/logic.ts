/**
 * Pure, storage-free logic for the workout tool.
 * Kept separate from index.tsx so it can be unit-tested in a plain node
 * environment (no React, no DOM, no host).
 */

import { z } from 'zod';

/* ── Docs / params ────────────────────────────────────────────────────── */

export type Exercise = {
  name: string;
  sets: number;
  reps: number;
  /** Omitted = bodyweight (volume counts sets × reps without a factor). */
  weightKg?: number;
};

export type SessionDoc = {
  /** Stable id, identical to the storage doc id ("session:<random>"). */
  id: string;
  type: 'session';
  /** Session date, yyyy-mm-dd LOCAL. */
  date: string;
  /** Free-text kind, e.g. "Push", "Legs", "Run". */
  kind: string;
  exercises: Exercise[];
  createdAt: string;
};

export type WeightUnit = 'kg' | 'lb';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const logSessionParamsSchema = z.object({
  kind: z.string().min(1),
  /** Defaults to today (LOCAL). */
  date: z.string().regex(ISO_DATE).optional(),
});
export type LogSessionParams = z.infer<typeof logSessionParamsSchema>;

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

/** Monday of the ISO week containing `date` (ISO weeks run Mon-Sun). */
export function isoWeekStart(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((day + 6) % 7));
}

export function makeSession(kind: string, date: string, now: Date = new Date()): SessionDoc {
  return {
    id: `session:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    type: 'session',
    date,
    kind: kind.trim(),
    exercises: [],
    createdAt: now.toISOString(),
  };
}

/* ── Volume math ──────────────────────────────────────────────────────── */

/**
 * Session volume: Σ sets × reps × weight. Bodyweight exercises (no weight
 * or weight 0) count as sets × reps, so they are not invisible in the stats.
 */
export function sessionVolume(session: Pick<SessionDoc, 'exercises'>): number {
  return session.exercises.reduce((acc, ex) => {
    const factor = ex.weightKg !== undefined && ex.weightKg > 0 ? ex.weightKg : 1;
    return acc + ex.sets * ex.reps * factor;
  }, 0);
}

/** Sessions inside the ISO week (Mon-Sun, LOCAL dates) containing `today`. */
export function sessionsThisWeek(sessions: SessionDoc[], today: string): SessionDoc[] {
  const start = isoWeekStart(today);
  const end = addDays(start, 6);
  return sessions.filter((s) => s.date >= start && s.date <= end);
}

/** Total volume of the ISO week containing `today`. */
export function weeklyVolume(sessions: SessionDoc[], today: string): number {
  return sessionsThisWeek(sessions, today).reduce((acc, s) => acc + sessionVolume(s), 0);
}

/** Volume per weekday (7 buckets, Monday first) of the ISO week of `today`. */
export function volumeByWeekday(sessions: SessionDoc[], today: string): number[] {
  const start = isoWeekStart(today);
  const buckets = Array.from({ length: 7 }, () => 0);
  for (const session of sessionsThisWeek(sessions, today)) {
    const index = Math.round(
      (new Date(`${session.date}T00:00:00Z`).getTime() -
        new Date(`${start}T00:00:00Z`).getTime()) /
        86_400_000,
    );
    if (index >= 0 && index < 7) buckets[index] = (buckets[index] ?? 0) + sessionVolume(session);
  }
  return buckets;
}

/* ── Personal records ─────────────────────────────────────────────────── */

export type PersonalRecord = {
  /** Display casing of the FIRST time the exercise was seen. */
  name: string;
  weightKg: number;
  /** Date the record was set; ties keep the EARLIEST date. */
  date: string;
};

/**
 * Max weight per exercise name (case-insensitive). Bodyweight entries are
 * skipped. A tie keeps the earliest date (the day the record was first hit).
 * Sorted by exercise name.
 */
export function personalRecords(sessions: SessionDoc[]): PersonalRecord[] {
  const byName = new Map<string, PersonalRecord>();
  const ordered = [...sessions].sort((a, b) => a.date.localeCompare(b.date));
  for (const session of ordered) {
    for (const ex of session.exercises) {
      if (ex.weightKg === undefined || ex.weightKg <= 0) continue;
      const key = ex.name.trim().toLowerCase();
      if (!key) continue;
      const existing = byName.get(key);
      if (!existing) {
        byName.set(key, { name: ex.name.trim(), weightKg: ex.weightKg, date: session.date });
      } else if (ex.weightKg > existing.weightKg) {
        byName.set(key, { name: existing.name, weightKg: ex.weightKg, date: session.date });
      }
      // equal weight → keep the existing (earliest) record
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* ── Units ────────────────────────────────────────────────────────────── */

export const KG_PER_LB = 0.45359237;

export function kgToLb(kg: number): number {
  return kg / KG_PER_LB;
}

/** "100 kg" / "220.5 lb" – one decimal, trailing .0 dropped. */
export function formatWeight(kg: number, unit: WeightUnit): string {
  const value = unit === 'kg' ? kg : kgToLb(kg);
  const rounded = Math.round(value * 10) / 10;
  return `${rounded} ${unit}`;
}

/* ── Assistant context ────────────────────────────────────────────────── */

/**
 * Compact snapshot for the assistant's "current state" context: this week's
 * sessions and volume plus the most recent personal record.
 */
export function buildWorkoutContext(
  sessions: SessionDoc[],
  language: string,
  today: string,
  unit: WeightUnit = 'kg',
): string {
  const de = language === 'de';
  if (sessions.length === 0) {
    return de ? 'Noch keine Workouts erfasst.' : 'No workouts logged yet.';
  }
  const week = sessionsThisWeek(sessions, today);
  const volume = Math.round(weeklyVolume(sessions, today));
  const kinds = week
    .map((s) => s.kind)
    .filter((k) => k)
    .join(', ');
  const head = de
    ? `Diese Woche ${week.length} Einheit(en)${kinds ? ` (${kinds})` : ''}, Volumen ≈ ${volume}.`
    : `This week ${week.length} session(s)${kinds ? ` (${kinds})` : ''}, volume ≈ ${volume}.`;
  const records = personalRecords(sessions);
  const latest = records.reduce<PersonalRecord | null>(
    (best, r) => (best === null || r.date > best.date ? r : best),
    null,
  );
  const tail = latest
    ? de
      ? `Letzter Rekord: «${latest.name}» ${formatWeight(latest.weightKg, unit)} am ${latest.date}.`
      : `Latest record: «${latest.name}» ${formatWeight(latest.weightKg, unit)} on ${latest.date}.`
    : de
      ? 'Noch keine Gewichts-Rekorde.'
      : 'No weight records yet.';
  return `${head} ${tail}`;
}
