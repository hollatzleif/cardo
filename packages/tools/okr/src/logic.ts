/**
 * Pure, storage-free logic for the okr tool.
 * Kept separate from index.tsx so it can be unit-tested in a plain node
 * environment (no React, no DOM, no host).
 */

import { z } from 'zod';

export type KeyResult = {
  /** Stable id, unique within its objective. */
  id: string;
  title: string;
  /** Current measured value – free-form number, may exceed the target. */
  current: number;
  /** Target value; targets ≤ 0 count as 0% progress (no division by zero). */
  target: number;
  /** Optional unit for display, e.g. "Artikel" or "%". */
  unit?: string;
};

/** One objective, stored as `objective:<random>`. */
export type ObjectiveDoc = {
  /** Stable id, identical to the storage doc id ("objective:<random>"). */
  id: string;
  type: 'objective';
  title: string;
  /** Optional quarter label, e.g. "Q3 2026". */
  quarter?: string;
  keyResults: KeyResult[];
  createdAt: string;
};

export const addObjectiveParamsSchema = z.object({
  title: z.string().min(1),
  quarter: z.string().optional(),
});
export type AddObjectiveParams = z.infer<typeof addObjectiveParamsSchema>;

export const updateKrParamsSchema = z.object({
  objective: z.string().min(1),
  keyResult: z.string().min(1),
  current: z.number().finite(),
});
export type UpdateKrParams = z.infer<typeof updateKrParamsSchema>;

export function makeId(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function makeObjective(
  input: { title: string; quarter?: string },
  now: Date = new Date(),
): ObjectiveDoc {
  const objective: ObjectiveDoc = {
    id: makeId('objective'),
    type: 'objective',
    title: input.title.trim(),
    keyResults: [],
    createdAt: now.toISOString(),
  };
  const quarter = input.quarter?.trim();
  if (quarter) objective.quarter = quarter;
  return objective;
}

export function makeKeyResult(input: { title: string; target: number; unit?: string }): KeyResult {
  const kr: KeyResult = {
    id: makeId('kr'),
    title: input.title.trim(),
    current: 0,
    target: input.target,
  };
  const unit = input.unit?.trim();
  if (unit) kr.unit = unit;
  return kr;
}

/**
 * Progress of one key result as a fraction, HARD-clamped into 0–1:
 * target ≤ 0 → 0 (no division by zero, no negative targets),
 * negative current → 0, overachievement → 1.
 */
export function krProgress(kr: Pick<KeyResult, 'current' | 'target'>): number {
  if (!Number.isFinite(kr.target) || kr.target <= 0) return 0;
  if (!Number.isFinite(kr.current)) return 0;
  return Math.min(1, Math.max(0, kr.current / kr.target));
}

/** Plain average of all KR progresses; an objective without KRs is 0. */
export function objectiveProgress(objective: Pick<ObjectiveDoc, 'keyResults'>): number {
  const krs = objective.keyResults;
  if (krs.length === 0) return 0;
  const sum = krs.reduce((acc, kr) => acc + krProgress(kr), 0);
  return sum / krs.length;
}

/** Trims float noise for display: 0.30000000000000004 → "0.3". */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return String(Math.round(value * 100) / 100);
}

/** "3/5 Artikel" – current/target plus the optional unit. */
export function formatKr(kr: Pick<KeyResult, 'current' | 'target' | 'unit'>): string {
  const base = `${formatNumber(kr.current)}/${formatNumber(kr.target)}`;
  return kr.unit ? `${base} ${kr.unit}` : base;
}

/** The objective with the LOWEST progress (ties: first), for single-focus. */
export function leastProgressed(objectives: ObjectiveDoc[]): ObjectiveDoc | null {
  let best: ObjectiveDoc | null = null;
  let bestProgress = Number.POSITIVE_INFINITY;
  for (const objective of objectives) {
    const progress = objectiveProgress(objective);
    if (progress < bestProgress) {
      best = objective;
      bestProgress = progress;
    }
  }
  return best;
}

/** Objectives sorted by progress ascending (least done first), ties by title. */
export function sortObjectives(objectives: ObjectiveDoc[]): ObjectiveDoc[] {
  return [...objectives].sort(
    (a, b) => objectiveProgress(a) - objectiveProgress(b) || a.title.localeCompare(b.title),
  );
}

/** Case-insensitive objective lookup: doc id, exact title, then unique substring. */
export function matchObjective(objectives: ObjectiveDoc[], ref: string): ObjectiveDoc | null {
  const needle = ref.trim().toLowerCase();
  if (!needle) return null;
  const byId = objectives.find((o) => o.id === ref);
  if (byId) return byId;
  const exact = objectives.find((o) => o.title.toLowerCase() === needle);
  if (exact) return exact;
  const partial = objectives.filter((o) => o.title.toLowerCase().includes(needle));
  return partial.length === 1 ? (partial[0] ?? null) : null;
}

/** Case-insensitive key-result lookup within an objective. */
export function matchKeyResult(
  objective: Pick<ObjectiveDoc, 'keyResults'>,
  ref: string,
): KeyResult | null {
  const needle = ref.trim().toLowerCase();
  if (!needle) return null;
  const byId = objective.keyResults.find((kr) => kr.id === ref);
  if (byId) return byId;
  const exact = objective.keyResults.find((kr) => kr.title.toLowerCase() === needle);
  if (exact) return exact;
  const partial = objective.keyResults.filter((kr) => kr.title.toLowerCase().includes(needle));
  return partial.length === 1 ? (partial[0] ?? null) : null;
}

/**
 * Compact snapshot for the assistant's "current state" context: every
 * objective with its overall percentage and each KR as "current/target unit".
 */
export function buildOkrContext(objectives: ObjectiveDoc[], language: string): string {
  const de = language === 'de';
  if (objectives.length === 0) return de ? 'Keine Objectives angelegt.' : 'No objectives yet.';
  const lines = sortObjectives(objectives).map((objective) => {
    const percent = Math.round(objectiveProgress(objective) * 100);
    const quarter = objective.quarter ? ` [${objective.quarter}]` : '';
    const krs =
      objective.keyResults.length === 0
        ? de
          ? 'noch keine Key Results'
          : 'no key results yet'
        : objective.keyResults
            .map((kr) => `«${kr.title}» ${formatKr(kr)} (${Math.round(krProgress(kr) * 100)}%)`)
            .join(', ');
    return `«${objective.title}»${quarter}: ${percent}% – ${krs}`;
  });
  const head = de ? `${objectives.length} Objectives.` : `${objectives.length} objectives.`;
  return `${head} ${lines.join(' · ')}`;
}
