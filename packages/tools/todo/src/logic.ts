/**
 * Pure, storage-free logic for the To-Do tool.
 * Kept separate from index.tsx so it can be unit-tested in a plain node
 * environment (no React, no DOM, no host).
 */

export type Priority = 'low' | 'medium' | 'high';

/** Kanban column a task lives in. Derived for legacy docs – see deriveStatus(). */
export type TaskStatus = 'todo' | 'doing' | 'done';

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
  /**
   * Kanban status. OPTIONAL for backward compatibility: docs written before
   * the board existed only carry `done`. Writers keep `status` and `done` in
   * sync (done:true ⇔ status:'done'); readers must go through deriveStatus().
   */
  status?: TaskStatus;
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

/**
 * Kanban status of a task. `done` stays the source of truth for completion:
 * done:true is always 'done', and an open task is 'doing' only if its status
 * field explicitly says so – everything else (legacy docs without a status
 * field, or an inconsistent open doc still carrying status:'done') is 'todo'.
 */
export function deriveStatus(task: Pick<TaskDoc, 'done' | 'status'>): TaskStatus {
  if (task.done) return 'done';
  return task.status === 'doing' ? 'doing' : 'todo';
}

/* ── "Today" query (consumed by the todo.query-today command) ─────────── */

export type TodayItem = {
  id: string;
  title: string;
  priority: Priority;
  due?: string;
  /** Display name of the task's list. */
  list: string;
  overdue: boolean;
};

export type TodayData = {
  /** Open tasks due today, overdue or high priority – capped at 10. */
  open: TodayItem[];
  dueToday: number;
  overdue: number;
  completedToday: number;
};

/** Local calendar date of an ISO timestamp, as yyyy-mm-dd. */
export function localDateOf(isoTimestamp: string): string {
  return todayIso(new Date(isoTimestamp));
}

/**
 * Pure core of the todo.query-today command. `today` is the LOCAL date
 * (todayIso()). Counts are computed over ALL tasks; the open list is capped
 * at 10 and sorted: overdue first, then due today, then by priority.
 */
export function computeTodayData(
  tasks: TaskDoc[],
  lists: Array<Pick<ListDoc, 'id' | 'name'>>,
  today: string,
): TodayData {
  const listName = new Map(lists.map((l) => [l.id, l.name]));
  const openTasks = tasks.filter((task) => !task.done);
  const bucket = (task: TaskDoc): number =>
    isOverdue(task, today) ? 0 : task.due === today ? 1 : 2;

  const relevant = openTasks
    .filter((task) => bucket(task) < 2 || task.priority === 'high')
    .sort((a, b) => {
      const byBucket = bucket(a) - bucket(b);
      if (byBucket !== 0) return byBucket;
      const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      if (byPriority !== 0) return byPriority;
      if (a.due !== b.due) {
        if (!a.due) return 1;
        if (!b.due) return -1;
        return a.due < b.due ? -1 : 1;
      }
      return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    });

  const open: TodayItem[] = relevant.slice(0, 10).map((task) => {
    const item: TodayItem = {
      id: task.id,
      title: task.title,
      priority: task.priority,
      list: listName.get(task.list) ?? task.list,
      overdue: isOverdue(task, today),
    };
    if (task.due) item.due = task.due;
    return item;
  });

  return {
    open,
    dueToday: openTasks.filter((task) => task.due === today).length,
    overdue: openTasks.filter((task) => isOverdue(task, today)).length,
    completedToday: tasks.filter(
      (task) => task.done && task.completedAt != null && localDateOf(task.completedAt) === today,
    ).length,
  };
}

/**
 * Compact snapshot of the task list for the assistant's "current state"
 * context, so it can spot duplicates and already-completed items instead of
 * blindly re-creating them. Open tasks first (priority/due order), then the
 * most recently completed ones (with a "today" marker). Capped for prompt size.
 */
export function buildTodoContext(tasks: TaskDoc[], language: string, now: Date = new Date()): string {
  const de = language === 'de';
  const today = todayIso(now);
  const open = tasks
    .filter((task) => !task.done)
    .sort((a, b) => {
      const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      if (byPriority !== 0) return byPriority;
      if ((a.due ?? '') !== (b.due ?? '')) {
        if (!a.due) return 1;
        if (!b.due) return -1;
        return a.due < b.due ? -1 : 1;
      }
      return 0;
    });
  const done = tasks
    .filter((task) => task.done && task.completedAt != null)
    .sort((a, b) => ((b.completedAt ?? '') < (a.completedAt ?? '') ? -1 : 1));

  const openLabels = open.slice(0, 25).map((task) => {
    const prio = task.priority === 'high' ? (de ? ' (Prio hoch)' : ' (high prio)') : '';
    const due = task.due ? (de ? `, fällig ${task.due}` : `, due ${task.due}`) : '';
    return `«${task.title}»${prio}${due}`;
  });
  const doneLabels = done.slice(0, 12).map((task) => {
    const onToday =
      task.completedAt && localDateOf(task.completedAt) === today ? (de ? ' (heute)' : ' (today)') : '';
    return `«${task.title}»${onToday}`;
  });

  const parts: string[] = [];
  parts.push(
    openLabels.length > 0
      ? `${de ? 'Offene Aufgaben' : 'Open tasks'}: ${openLabels.join(', ')}.`
      : de
        ? 'Keine offenen Aufgaben.'
        : 'No open tasks.',
  );
  if (doneLabels.length > 0) {
    parts.push(`${de ? 'Kürzlich erledigt' : 'Recently completed'}: ${doneLabels.join(', ')}.`);
  }
  return parts.join(' ');
}

/** Case-insensitive title/category match for the global search provider. */
export function matchesQuery(task: Pick<TaskDoc, 'title' | 'category'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return (
    task.title.toLowerCase().includes(q) || (task.category ?? '').toLowerCase().includes(q)
  );
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
