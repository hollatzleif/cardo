/**
 * Pure, storage-free logic for the Eisenhower Matrix tool.
 * Kept separate from index.tsx so it can be unit-tested in a plain node
 * environment (no React, no DOM, no host).
 */

/** The four Eisenhower quadrants: urgent/important combinations. */
export type Quadrant = 'q1' | 'q2' | 'q3' | 'q4';

/** Render/iteration order: q1 (do) → q2 (schedule) → q3 (delegate) → q4 (drop). */
export const QUADRANTS: Quadrant[] = ['q1', 'q2', 'q3', 'q4'];

export type TaskDoc = {
  /**
   * Stable id, identical to the storage doc id. query() returns doc bodies
   * WITHOUT their ids, so the id always lives inside the doc as well.
   */
  id: string;
  type: 'task';
  title: string;
  quadrant: Quadrant;
  done: boolean;
  createdAt: string;
};

export function makeId(): string {
  return `task:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function makeTask(
  input: { title: string; quadrant: Quadrant },
  now: Date = new Date(),
): TaskDoc {
  return {
    id: makeId(),
    type: 'task',
    title: input.title.trim(),
    quadrant: input.quadrant,
    done: false,
    createdAt: now.toISOString(),
  };
}

/**
 * Reducer: move a task to another quadrant. Returns the SAME object when
 * nothing changes (no-op moves cause no storage write), a new doc otherwise.
 */
export function moveTask(task: TaskDoc, quadrant: Quadrant): TaskDoc {
  if (task.quadrant === quadrant) return task;
  return { ...task, quadrant };
}

/** Reducer: set the done flag. Same-object return on no-op, like moveTask. */
export function setDone(task: TaskDoc, done: boolean): TaskDoc {
  if (task.done === done) return task;
  return { ...task, done };
}

/** Open tasks first (oldest first within each half), completed ones at the end. */
export function sortTasks(tasks: TaskDoc[]): TaskDoc[] {
  return [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });
}

/** Buckets every task into its quadrant; each bucket is sortTasks()-ordered. */
export function groupByQuadrant(tasks: TaskDoc[]): Record<Quadrant, TaskDoc[]> {
  const groups: Record<Quadrant, TaskDoc[]> = { q1: [], q2: [], q3: [], q4: [] };
  for (const task of tasks) groups[task.quadrant].push(task);
  for (const quadrant of QUADRANTS) groups[quadrant] = sortTasks(groups[quadrant]);
  return groups;
}

/** Semantic chart token for a quadrant's accent color. */
export function quadrantToken(quadrant: Quadrant): 'chart-1' | 'chart-2' | 'chart-3' | 'chart-4' {
  switch (quadrant) {
    case 'q1':
      return 'chart-1';
    case 'q2':
      return 'chart-2';
    case 'q3':
      return 'chart-3';
    case 'q4':
      return 'chart-4';
  }
}

const QUADRANT_LABELS: Record<'en' | 'de', Record<Quadrant, string>> = {
  en: {
    q1: 'urgent & important',
    q2: 'important, not urgent',
    q3: 'urgent, not important',
    q4: 'neither',
  },
  de: {
    q1: 'dringend & wichtig',
    q2: 'wichtig, nicht dringend',
    q3: 'dringend, nicht wichtig',
    q4: 'weder noch',
  },
};

/**
 * Compact snapshot of the matrix for the assistant's "current state" context,
 * so it can spot duplicates and suggest quadrants instead of blindly adding.
 * Open tasks per quadrant (capped for prompt size) plus a completed count.
 */
export function buildEisenhowerContext(tasks: TaskDoc[], language: string): string {
  const de = language === 'de';
  const labels = QUADRANT_LABELS[de ? 'de' : 'en'];
  const open = tasks.filter((task) => !task.done);
  const doneCount = tasks.length - open.length;

  if (open.length === 0 && doneCount === 0) {
    return de ? 'Die Eisenhower-Matrix ist leer.' : 'The Eisenhower matrix is empty.';
  }

  const groups = groupByQuadrant(open);
  const parts: string[] = [];
  for (const quadrant of QUADRANTS) {
    const bucket = groups[quadrant];
    if (bucket.length === 0) continue;
    const titles = bucket.slice(0, 10).map((task) => `«${task.title}»`);
    parts.push(`${quadrant.toUpperCase()} (${labels[quadrant]}): ${titles.join(', ')}`);
  }
  if (parts.length === 0) {
    parts.push(de ? 'Keine offenen Aufgaben' : 'No open tasks');
  }
  if (doneCount > 0) {
    parts.push(de ? `${doneCount} erledigt` : `${doneCount} completed`);
  }
  return `${parts.join('. ')}.`;
}
