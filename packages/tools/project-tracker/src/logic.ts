/**
 * Pure, storage-free logic for the project-tracker tool.
 * Kept separate from index.tsx so it can be unit-tested in a plain node
 * environment (no React, no DOM, no host).
 */

import { z } from 'zod';

export type ColorToken =
  | 'chart-1'
  | 'chart-2'
  | 'chart-3'
  | 'chart-4'
  | 'chart-5'
  | 'chart-6'
  | 'chart-7'
  | 'chart-8';

export const COLOR_TOKENS: ColorToken[] = [
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'chart-6',
  'chart-7',
  'chart-8',
];

export type Milestone = {
  /** Stable id, unique within its project. */
  id: string;
  title: string;
  /** Optional due date, YYYY-MM-DD. */
  due?: string;
  done: boolean;
};

/** One project, stored as `project:<random>`. */
export type ProjectDoc = {
  /** Stable id, identical to the storage doc id ("project:<random>"). */
  id: string;
  type: 'project';
  name: string;
  /** Semantic chart token – rendered as `var(--<token>)`, never a raw color. */
  colorToken: ColorToken;
  milestones: Milestone[];
  createdAt: string;
};

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const addProjectParamsSchema = z.object({
  name: z.string().min(1),
});
export type AddProjectParams = z.infer<typeof addProjectParamsSchema>;

export const addMilestoneParamsSchema = z.object({
  project: z.string().min(1),
  title: z.string().min(1),
  due: z.string().regex(DATE_RE).optional(),
});
export type AddMilestoneParams = z.infer<typeof addMilestoneParamsSchema>;

export const completeMilestoneParamsSchema = z.object({
  project: z.string().min(1),
  title: z.string().min(1),
});
export type CompleteMilestoneParams = z.infer<typeof completeMilestoneParamsSchema>;

/** YYYY-MM-DD and actually a real calendar date (rejects e.g. 2026-13-40). */
export function isValidDateKey(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === date;
}

/** Local date as YYYY-MM-DD (lexicographically comparable with `due`). */
export function todayIso(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

export function makeId(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Rotating chart token so every new project gets a distinguishable color. */
export function pickColorToken(existingCount: number): ColorToken {
  const index = ((existingCount % COLOR_TOKENS.length) + COLOR_TOKENS.length) % COLOR_TOKENS.length;
  return COLOR_TOKENS[index] ?? 'chart-1';
}

export function makeProject(name: string, existingCount: number, now: Date = new Date()): ProjectDoc {
  return {
    id: makeId('project'),
    type: 'project',
    name: name.trim(),
    colorToken: pickColorToken(existingCount),
    milestones: [],
    createdAt: now.toISOString(),
  };
}

export function makeMilestone(input: { title: string; due?: string }): Milestone {
  const milestone: Milestone = { id: makeId('ms'), title: input.title.trim(), done: false };
  if (input.due) milestone.due = input.due;
  return milestone;
}

/** Fraction of done milestones, 0–1. An empty project is 0. */
export function progressOf(project: Pick<ProjectDoc, 'milestones'>): number {
  const total = project.milestones.length;
  if (total === 0) return 0;
  const done = project.milestones.filter((m) => m.done).length;
  return done / total;
}

/**
 * The earliest UNDONE milestone by due date; undated milestones come last
 * (first undated in stored order wins among themselves). Null when everything
 * is done or the project has no milestones.
 */
export function nextMilestone(project: Pick<ProjectDoc, 'milestones'>): Milestone | null {
  let best: Milestone | null = null;
  for (const m of project.milestones) {
    if (m.done) continue;
    if (!best) {
      best = m;
      continue;
    }
    if (m.due && (!best.due || m.due < best.due)) best = m;
  }
  return best;
}

/** An undone milestone with a due date strictly before today is overdue. */
export function isOverdue(milestone: Pick<Milestone, 'due' | 'done'>, today: string): boolean {
  return !milestone.done && typeof milestone.due === 'string' && milestone.due < today;
}

/** A project with at least one milestone, all of them done. */
export function isCompleted(project: Pick<ProjectDoc, 'milestones'>): boolean {
  return project.milestones.length > 0 && project.milestones.every((m) => m.done);
}

/**
 * Active projects first, ordered by their next due date (undated/empty
 * projects after the dated ones); completed projects last. Ties break by name.
 */
export function sortProjects(projects: ProjectDoc[]): ProjectDoc[] {
  const rank = (p: ProjectDoc): { group: number; due: string } => {
    if (isCompleted(p)) return { group: 2, due: '' };
    const next = nextMilestone(p);
    if (next?.due) return { group: 0, due: next.due };
    return { group: 1, due: '' };
  };
  return [...projects].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra.group !== rb.group) return ra.group - rb.group;
    if (ra.due !== rb.due) return ra.due < rb.due ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** Case-insensitive project lookup: doc id, exact name, then unique substring. */
export function matchProject(projects: ProjectDoc[], ref: string): ProjectDoc | null {
  const needle = ref.trim().toLowerCase();
  if (!needle) return null;
  const byId = projects.find((p) => p.id === ref);
  if (byId) return byId;
  const exact = projects.find((p) => p.name.toLowerCase() === needle);
  if (exact) return exact;
  const partial = projects.filter((p) => p.name.toLowerCase().includes(needle));
  return partial.length === 1 ? (partial[0] ?? null) : null;
}

/** Case-insensitive milestone lookup within a project: exact title, then unique substring. */
export function matchMilestone(
  project: Pick<ProjectDoc, 'milestones'>,
  ref: string,
): Milestone | null {
  const needle = ref.trim().toLowerCase();
  if (!needle) return null;
  const exact = project.milestones.find((m) => m.title.toLowerCase() === needle);
  if (exact) return exact;
  const partial = project.milestones.filter((m) => m.title.toLowerCase().includes(needle));
  return partial.length === 1 ? (partial[0] ?? null) : null;
}

/**
 * Compact snapshot for the assistant's "current state" context: per project
 * the progress percentage plus the next milestone (with due date and overdue
 * flag).
 */
export function buildProjectContext(
  projects: ProjectDoc[],
  language: string,
  today: string,
): string {
  const de = language === 'de';
  if (projects.length === 0) return de ? 'Keine Projekte angelegt.' : 'No projects yet.';
  const lines = sortProjects(projects).map((project) => {
    const percent = Math.round(progressOf(project) * 100);
    const done = project.milestones.filter((m) => m.done).length;
    const head = `«${project.name}»: ${percent}% (${done}/${project.milestones.length})`;
    if (isCompleted(project)) return de ? `${head}, abgeschlossen` : `${head}, completed`;
    const next = nextMilestone(project);
    if (!next) return de ? `${head}, noch keine Meilensteine` : `${head}, no milestones yet`;
    const due = next.due
      ? isOverdue(next, today)
        ? de
          ? ` (überfällig seit ${next.due})`
          : ` (overdue since ${next.due})`
        : ` (${next.due})`
      : '';
    return de
      ? `${head}, als Nächstes «${next.title}»${due}`
      : `${head}, next up «${next.title}»${due}`;
  });
  const head = de ? `${projects.length} Projekte.` : `${projects.length} projects.`;
  return `${head} ${lines.join(' · ')}`;
}
