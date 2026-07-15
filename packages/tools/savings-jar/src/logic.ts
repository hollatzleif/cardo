/**
 * Pure, storage-free logic for the savings-jar tool.
 * Kept separate from index.tsx so it can be unit-tested in a plain node
 * environment (no React, no DOM, no host).
 */

import { z } from 'zod';

export type GoalDoc = {
  /** Stable id, identical to the storage doc id ("goal:<random>"). */
  id: string;
  type: 'goal';
  name: string;
  /** Target amount in the user's display currency (no FX math anywhere). */
  target: number;
  /** Amount saved so far – never negative. */
  saved: number;
  /** Optional target date, yyyy-mm-dd. */
  deadline?: string;
  createdAt: string;
};

/** Params of the savings-jar.add-goal command (zero/negative targets reject). */
export const addGoalParamsSchema = z.object({
  name: z.string().min(1),
  target: z.number().positive(),
  deadline: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export type AddGoalParams = z.infer<typeof addGoalParamsSchema>;

/** Params of the savings-jar.contribute command (zero/negative amounts reject). */
export const contributeParamsSchema = z.object({
  id: z.string().min(1),
  amount: z.number().positive(),
});
export type ContributeParams = z.infer<typeof contributeParamsSchema>;

export function makeGoalId(): string {
  return `goal:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function makeGoal(
  input: { name: string; target: number; deadline?: string },
  now: Date = new Date(),
): GoalDoc {
  const goal: GoalDoc = {
    id: makeGoalId(),
    type: 'goal',
    name: input.name.trim(),
    target: input.target,
    saved: 0,
    createdAt: now.toISOString(),
  };
  if (input.deadline) goal.deadline = input.deadline;
  return goal;
}

/** yyyy-mm-dd and actually a real calendar date (rejects e.g. 2026-13-40). */
export function isValidDeadline(deadline: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return false;
  const date = new Date(`${deadline}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  return date.toISOString().slice(0, 10) === deadline;
}

/** Local date as yyyy-mm-dd (lexicographically comparable with deadlines). */
export function todayIso(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

/**
 * Fraction saved, clamped to 0..1. Goals with target <= 0 report 0 –
 * there is no meaningful progress towards "nothing" (and no division by 0).
 */
export function progressOf(goal: Pick<GoalDoc, 'target' | 'saved'>): number {
  if (goal.target <= 0) return 0;
  return Math.min(1, Math.max(0, goal.saved / goal.target));
}

/** Whole days from `today` until `date` (both yyyy-mm-dd); negative when past. */
export function daysUntil(date: string, today: string): number {
  const a = new Date(`${today}T00:00:00Z`).getTime();
  const b = new Date(`${date}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Amount that still needs to be saved per day to reach the target by the
 * deadline. 0 without a deadline, when the target is already reached or when
 * the deadline is in the past (no meaningful daily rate anymore). A deadline
 * of TODAY means "the whole rest today" – the day count is floored at 1, so
 * there is never a division by zero.
 */
export function neededPerDay(goal: GoalDoc, today: string): number {
  if (!goal.deadline) return 0;
  const remaining = goal.target - goal.saved;
  if (remaining <= 0) return 0;
  const days = daysUntil(goal.deadline, today);
  if (days < 0) return 0;
  return remaining / Math.max(1, days);
}

/**
 * Whether the goal keeps up with a linear saving schedule from its creation
 * date to the deadline. Goals without a deadline (or with target <= 0) are
 * always on track; a reached goal is always on track; a passed deadline
 * without the target being reached never is. A deadline on/before the
 * creation day means the full amount was due immediately.
 */
export function onTrack(goal: GoalDoc, today: string): boolean {
  if (goal.target <= 0) return true;
  if (goal.saved >= goal.target) return true;
  if (!goal.deadline) return true;
  if (daysUntil(goal.deadline, today) < 0) return false;
  const createdDate = goal.createdAt.slice(0, 10);
  const total = daysUntil(goal.deadline, createdDate);
  if (total <= 0) return false;
  const elapsed = daysUntil(today, createdDate);
  const expected = goal.target * Math.min(1, Math.max(0, elapsed / total));
  return goal.saved >= expected - 1e-9;
}

/** "1,234.5 €" style display string – number formatting follows the UI language. */
export function formatMoney(value: number, language: string, currency: string): string {
  const num = new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(value);
  return currency ? `${num} ${currency}` : num;
}

/**
 * Compact snapshot of all goals for the assistant's "current state" context.
 * Includes each goal's doc id so the assistant can call savings-jar.contribute
 * without guessing ids.
 */
export function buildSavingsContext(goals: GoalDoc[], language: string, today: string): string {
  const de = language === 'de';
  if (goals.length === 0) return de ? 'Keine Sparziele angelegt.' : 'No savings goals yet.';
  const nf = new Intl.NumberFormat(language, { maximumFractionDigits: 2 });
  const items = [...goals]
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    .map((goal) => {
      const pct = Math.round(progressOf(goal) * 100);
      const base = `«${goal.name}» (id ${goal.id}): ${nf.format(goal.saved)} / ${nf.format(goal.target)} (${pct} %)`;
      if (!goal.deadline) return base;
      const rate = neededPerDay(goal, today);
      const deadline = de ? `, Frist ${goal.deadline}` : `, deadline ${goal.deadline}`;
      const perDay =
        rate > 0 ? (de ? `, braucht ${nf.format(rate)}/Tag` : `, needs ${nf.format(rate)}/day`) : '';
      const track = onTrack(goal, today)
        ? de
          ? ', im Plan'
          : ', on track'
        : de
          ? ', hinter dem Plan'
          : ', behind plan';
      return `${base}${deadline}${perDay}${track}`;
    });
  return `${de ? 'Sparziele' : 'Savings goals'}: ${items.join('; ')}.`;
}
