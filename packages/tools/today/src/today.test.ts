import { describe, expect, it } from 'vitest';
import {
  aggregateToday,
  emptyToday,
  hasAnySection,
  parseCalendar,
  parseTodo,
  sortEvents,
  sortTasks,
  type TodayCtx,
} from './aggregate';

/**
 * Aggregation runs against a hand-rolled minimal ctx (only the command
 * gateway matters) – no React, no workspace package resolution needed.
 */

type Handler = (params: unknown) => Promise<{ ok: boolean; data?: unknown }>;

function ctxWith(handlers: Record<string, Handler>): TodayCtx {
  return {
    commands: {
      has: (id) => id in handlers,
      execute: async (id, params) => {
        const handler = handlers[id];
        // Mirrors the host: executing an unknown command rejects. Reaching
        // this without a prior has() guard is exactly the bug we test against.
        if (!handler) throw new Error(`unknown command "${id}"`);
        return handler(params);
      },
    },
  };
}

const todoPayload = {
  open: [
    { id: 'a', title: 'Water the plants', list: 'home', overdue: false },
    { id: 'b', title: 'File taxes', priority: 'high', due: '2026-07-10', overdue: true },
  ],
  dueToday: 1,
  overdue: 1,
  completedToday: 3,
};

describe('aggregateToday', () => {
  it('returns the empty structure without throwing when no commands exist', async () => {
    const data = await aggregateToday(ctxWith({}));
    expect(data).toEqual(emptyToday());
    expect(hasAnySection(data)).toBe(false);
  });

  it('aggregates all four providers', async () => {
    const data = await aggregateToday(
      ctxWith({
        'todo.query-today': async () => ({ ok: true, data: todoPayload }),
        'calendar.query-today': async () => ({
          ok: true,
          data: {
            events: [
              { id: 'e1', title: 'Standup', time: '09:30' },
              { id: 'e2', title: 'Holiday' },
            ],
            count: 2,
          },
        }),
        'routine.query-status': async () => ({ ok: true, data: { total: 5, done: 2 } }),
        'habits.query-status': async () => ({
          ok: true,
          data: { total: 4, doneToday: 3, bestStreak: 12 },
        }),
      }),
    );

    expect(hasAnySection(data)).toBe(true);
    expect(data.todo?.completedToday).toBe(3);
    expect(data.todo?.open.map((t) => t.id)).toEqual(['b', 'a']); // overdue first
    expect(data.calendar?.count).toBe(2);
    expect(data.calendar?.events.map((e) => e.id)).toEqual(['e2', 'e1']); // all-day first
    expect(data.routine).toEqual({ total: 5, done: 2 });
    expect(data.habits).toEqual({ total: 4, doneToday: 3, bestStreak: 12 });
  });

  it('shows available sections even when others are missing', async () => {
    const data = await aggregateToday(
      ctxWith({ 'routine.query-status': async () => ({ ok: true, data: { total: 3, done: 3 } }) }),
    );
    expect(data.routine).toEqual({ total: 3, done: 3 });
    expect(data.todo).toBeNull();
    expect(data.calendar).toBeNull();
    expect(data.habits).toBeNull();
  });

  it('hides a section whose provider throws, keeping the others', async () => {
    const data = await aggregateToday(
      ctxWith({
        'todo.query-today': async () => {
          throw new Error('provider exploded');
        },
        'habits.query-status': async () => ({
          ok: true,
          data: { total: 1, doneToday: 0, bestStreak: 0 },
        }),
      }),
    );
    expect(data.todo).toBeNull();
    expect(data.habits).toEqual({ total: 1, doneToday: 0, bestStreak: 0 });
  });

  it('hides a section whose provider reports ok: false', async () => {
    const data = await aggregateToday(
      ctxWith({ 'calendar.query-today': async () => ({ ok: false }) }),
    );
    expect(data.calendar).toBeNull();
  });

  it('tolerates malformed provider payloads', async () => {
    const data = await aggregateToday(
      ctxWith({
        'todo.query-today': async () => ({ ok: true, data: 'not an object' }),
        'calendar.query-today': async () => ({
          ok: true,
          data: { events: [{ id: 42, title: null }, 'garbage', { id: 'ok', title: 'Valid' }] },
        }),
        'routine.query-status': async () => ({ ok: true, data: { total: 'NaN', done: null } }),
      }),
    );
    expect(data.todo).toBeNull();
    expect(data.calendar?.events).toEqual([{ id: 'ok', title: 'Valid', time: undefined }]);
    expect(data.calendar?.count).toBe(1); // falls back to the parsed length
    expect(data.routine).toEqual({ total: 0, done: 0 });
  });
});

describe('parsing and sorting helpers', () => {
  it('parseTodo drops entries without id or title and defaults counters', () => {
    const parsed = parseTodo({ open: [{ id: 'x' }, { id: 'y', title: 'Y' }] });
    expect(parsed?.open).toEqual([
      { id: 'y', title: 'Y', priority: undefined, due: undefined, list: undefined, overdue: false },
    ]);
    expect(parsed).toMatchObject({ dueToday: 0, overdue: 0, completedToday: 0 });
  });

  it('parseCalendar uses the declared count when present', () => {
    const parsed = parseCalendar({ events: [{ id: 'e', title: 'E' }], count: 7 });
    expect(parsed?.count).toBe(7);
  });

  it('sortTasks is stable within overdue and non-overdue groups', () => {
    const sorted = sortTasks([
      { id: '1', title: 'a', overdue: false },
      { id: '2', title: 'b', overdue: true },
      { id: '3', title: 'c', overdue: false },
      { id: '4', title: 'd', overdue: true },
    ]);
    expect(sorted.map((t) => t.id)).toEqual(['2', '4', '1', '3']);
  });

  it('sortEvents puts all-day events first, then sorts by time', () => {
    const sorted = sortEvents([
      { id: '1', title: 'late', time: '18:00' },
      { id: '2', title: 'all-day' },
      { id: '3', title: 'early', time: '08:15' },
    ]);
    expect(sorted.map((e) => e.id)).toEqual(['2', '3', '1']);
  });
});
