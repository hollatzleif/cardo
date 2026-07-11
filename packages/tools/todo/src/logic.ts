/**
 * Pure, storage-free logic for the To-Do tool.
 * Kept separate from index.tsx so it can be unit-tested in a plain node
 * environment (no React, no DOM, no host).
 */

export type Priority = 'low' | 'medium' | 'high';

export type TaskDoc = {
  /**
   * Stable id, identical to the storage doc id. query() returns doc bodies
   * WITHOUT their ids, so the id always lives inside the doc as well.
   */
  id: string;
  type: 'task';
  title: string;
  /** Full doc id of the list this task belongs to, e.g. "list:inbox". */
  list: string;
  priority: Priority;
  category?: string;
  /** ISO date, yyyy-mm-dd */
  due?: string;
  done: boolean;
  createdAt: string;
  completedAt: string | null;
};

export type ListDoc = {
  /** Stable id, identical to the storage doc id (see TaskDoc.id). */
  id: string;
  type: 'list';
  name: string;
  createdAt: string;
};

/** Doc id of the default list that is auto-created on first use. */
export const INBOX_ID = 'list:inbox';

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

export function makeId(prefix: 'task' | 'list'): string {
  return `${prefix}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function makeTask(
  input: { title: string; list: string; priority?: Priority; category?: string; due?: string },
  now: Date = new Date(),
): TaskDoc {
  const task: TaskDoc = {
    id: makeId('task'),
    type: 'task',
    title: input.title.trim(),
    list: input.list,
    priority: input.priority ?? 'medium',
    done: false,
    createdAt: now.toISOString(),
    completedAt: null,
  };
  const category = input.category?.trim();
  if (category) task.category = category;
  if (input.due) task.due = input.due;
  return task;
}

/** yyyy-mm-dd, and actually a real calendar date (rejects e.g. 2026-13-40). */
export function isValidDue(due: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return false;
  const date = new Date(`${due}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  return date.toISOString().slice(0, 10) === due;
}

/** Local date as yyyy-mm-dd (lexicographically comparable with TaskDoc.due). */
export function todayIso(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

export function isOverdue(task: Pick<TaskDoc, 'due' | 'done'>, today: string): boolean {
  return !task.done && typeof task.due === 'string' && task.due < today;
}

/** Semantic color token for the priority indicator dot. */
export function priorityToken(priority: Priority): 'danger' | 'warning' | 'text-muted' {
  return priority === 'high' ? 'danger' : priority === 'medium' ? 'warning' : 'text-muted';
}

/** Open tasks: high priority first, then earliest due (no due date last), then oldest. */
export function sortOpenTasks(tasks: TaskDoc[]): TaskDoc[] {
  return [...tasks].sort((a, b) => {
    const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (byPriority !== 0) return byPriority;
    if (a.due !== b.due) {
      if (!a.due) return 1;
      if (!b.due) return -1;
      return a.due < b.due ? -1 : 1;
    }
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });
}

/** Completed tasks: most recently completed first. */
export function sortCompletedTasks(tasks: TaskDoc[]): TaskDoc[] {
  return [...tasks].sort((a, b) => {
    const ca = a.completedAt ?? '';
    const cb = b.completedAt ?? '';
    return ca < cb ? 1 : ca > cb ? -1 : 0;
  });
}
