/**
 * Pure aggregation for the Today widget.
 *
 * Architecture rule: tools NEVER read foreign storage. Everything the Today
 * widget shows flows through the sanctioned Command API of the providing
 * tools. Every provider is optional – a missing or failing command simply
 * yields `null` for its section (graceful degradation).
 *
 * This module is deliberately import-free so it can be unit-tested in a
 * plain Node environment without resolving any workspace packages.
 */

/** The slice of ToolContext the aggregation needs (structurally compatible). */
export type CommandGateway = {
  has(id: string): boolean;
  execute(
    id: string,
    params: unknown,
  ): Promise<{ ok: boolean; messageKey?: string; data?: unknown }>;
};

export type TodayCtx = { commands: CommandGateway };

/* ── Provider contracts (as exposed by the other tools) ──────────────── */

export type TodayTask = {
  id: string;
  title: string;
  priority?: string;
  due?: string;
  list?: string;
  overdue: boolean;
};

export type TodoSummary = {
  open: TodayTask[];
  dueToday: number;
  overdue: number;
  completedToday: number;
};

export type TodayEvent = {
  id: string;
  title: string;
  /** "HH:MM" – undefined means all-day. */
  time?: string;
};

export type CalendarSummary = { events: TodayEvent[]; count: number };
export type RoutineSummary = { total: number; done: number };
export type HabitsSummary = { total: number; doneToday: number; bestStreak: number };

export type TodayData = {
  todo: TodoSummary | null;
  calendar: CalendarSummary | null;
  routine: RoutineSummary | null;
  habits: HabitsSummary | null;
};

export const PROVIDER_COMMANDS = {
  todo: 'todo.query-today',
  calendar: 'calendar.query-today',
  routine: 'routine.query-status',
  habits: 'habits.query-status',
} as const;

export function emptyToday(): TodayData {
  return { todo: null, calendar: null, routine: null, habits: null };
}

export function hasAnySection(data: TodayData): boolean {
  return (
    data.todo !== null || data.calendar !== null || data.routine !== null || data.habits !== null
  );
}

/**
 * Number of concrete items on today's plate: events + open tasks.
 * Missing sections simply contribute 0 (graceful degradation, as everywhere).
 * Powers the "compact" widget variant's single-line summary.
 */
export function countTodayItems(data: TodayData): number {
  return (data.calendar?.events.length ?? 0) + (data.todo?.open.length ?? 0);
}

/* ── Defensive parsing (provider payloads are foreign data) ──────────── */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Overdue tasks first; otherwise keep the provider's order (sort is stable). */
export function sortTasks(tasks: TodayTask[]): TodayTask[] {
  return [...tasks].sort((a, b) => Number(b.overdue) - Number(a.overdue));
}

/** All-day events (no time) first, then chronologically by "HH:MM". */
export function sortEvents(events: TodayEvent[]): TodayEvent[] {
  return [...events].sort((a, b) => {
    if (!a.time && !b.time) return 0;
    if (!a.time) return -1;
    if (!b.time) return 1;
    return a.time.localeCompare(b.time);
  });
}

export function parseTodo(data: unknown): TodoSummary | null {
  if (!isRecord(data)) return null;
  const open: TodayTask[] = [];
  for (const raw of Array.isArray(data.open) ? data.open : []) {
    if (!isRecord(raw)) continue;
    const id = optStr(raw.id);
    const title = optStr(raw.title);
    if (!id || !title) continue;
    open.push({
      id,
      title,
      priority: optStr(raw.priority),
      due: optStr(raw.due),
      list: optStr(raw.list),
      overdue: raw.overdue === true,
    });
  }
  return {
    open: sortTasks(open),
    dueToday: num(data.dueToday),
    overdue: num(data.overdue),
    completedToday: num(data.completedToday),
  };
}

export function parseCalendar(data: unknown): CalendarSummary | null {
  if (!isRecord(data)) return null;
  const events: TodayEvent[] = [];
  for (const raw of Array.isArray(data.events) ? data.events : []) {
    if (!isRecord(raw)) continue;
    const id = optStr(raw.id);
    const title = optStr(raw.title);
    if (!id || !title) continue;
    events.push({ id, title, time: optStr(raw.time) });
  }
  return { events: sortEvents(events), count: num(data.count, events.length) };
}

export function parseRoutine(data: unknown): RoutineSummary | null {
  if (!isRecord(data)) return null;
  return { total: num(data.total), done: num(data.done) };
}

export function parseHabits(data: unknown): HabitsSummary | null {
  if (!isRecord(data)) return null;
  return {
    total: num(data.total),
    doneToday: num(data.doneToday),
    bestStreak: num(data.bestStreak),
  };
}

/* ── Aggregation ─────────────────────────────────────────────────────── */

async function section<T>(
  ctx: TodayCtx,
  commandId: string,
  parse: (data: unknown) => T | null,
): Promise<T | null> {
  // Guard: the providing tool may be deactivated (or never installed).
  if (!ctx.commands.has(commandId)) return null;
  try {
    const result = await ctx.commands.execute(commandId, {});
    if (!result.ok) return null;
    return parse(result.data);
  } catch {
    // A broken provider must never break the Today widget.
    return null;
  }
}

export async function aggregateToday(ctx: TodayCtx): Promise<TodayData> {
  const [todo, calendar, routine, habits] = await Promise.all([
    section(ctx, PROVIDER_COMMANDS.todo, parseTodo),
    section(ctx, PROVIDER_COMMANDS.calendar, parseCalendar),
    section(ctx, PROVIDER_COMMANDS.routine, parseRoutine),
    section(ctx, PROVIDER_COMMANDS.habits, parseHabits),
  ]);
  return { todo, calendar, routine, habits };
}
