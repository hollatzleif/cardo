import { describe, expect, it } from 'vitest';
import type { CommandResult } from '@cardo/plugin-api';
import { createMemoryStorage } from '@cardo/plugin-api/testing';
import {
  alarmTodoId,
  FEED_DOC,
  isGoogleEvent,
  removeGoogleFeed,
  syncGoogleFeed,
  type FeedDeps,
} from './subscription';

const URL = 'https://calendar.google.com/calendar/ical/heike%40gmail.com/private-x/basic.ics';
const NOW = Date.UTC(2026, 9, 8, 10, 0); // 2026-10-08

const ics = (...events: Array<[uid: string, date: string, summary: string, extra?: string[]]>) =>
  [
    'BEGIN:VCALENDAR',
    ...events.flatMap(([uid, date, summary, extra = []]) => [
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTART;VALUE=DATE:${date}`,
      `SUMMARY:${summary}`,
      ...extra,
      'END:VEVENT',
    ]),
    'END:VCALENDAR',
  ].join('\r\n');

/** A tiny stand-in for the todo tool's commands. */
function fakeTodos() {
  const tasks = new Map<string, { title: string; due?: string; done: boolean }>();
  const execute = async (id: string, params: unknown): Promise<CommandResult> => {
    const p = params as { id: string; title?: string; due?: string; onlyIfOpen?: boolean };
    if (id === 'todo.create') {
      if (!tasks.has(p.id)) tasks.set(p.id, { title: p.title!, due: p.due, done: false });
      return { ok: true };
    }
    if (id === 'todo.update') {
      const t = tasks.get(p.id);
      if (t && !t.done) tasks.set(p.id, { ...t, title: p.title ?? t.title, due: p.due ?? t.due });
      return { ok: true };
    }
    if (id === 'todo.delete') {
      const t = tasks.get(p.id);
      if (t && !(p.onlyIfOpen && t.done)) tasks.delete(p.id);
      return { ok: true };
    }
    return { ok: false };
  };
  return { tasks, execute };
}

async function setup(feedText: { current: string }) {
  const storage = createMemoryStorage();
  await storage.set(FEED_DOC, { url: URL });
  const todos = fakeTodos();
  const deps: FeedDeps = {
    storage,
    fetchIcs: async () => feedText.current,
    execute: todos.execute,
    hasCommand: () => true,
    now: () => NOW,
  };
  const googleEvents = async () =>
    (await storage.query<Record<string, unknown>>())
      .filter(isGoogleEvent)
      .map((e) => `${e.date} ${e.title}`)
      .sort();
  return { storage, todos, deps, googleEvents };
}

describe('Google Calendar subscription', () => {
  it('mirrors appointments and turns ⏰ ones into to-dos', async () => {
    const feed = {
      current: ics(['a', '20261012', 'Supervision'], ['b', '20261015', '⏰ Steuer abgeben']),
    };
    const { deps, todos, googleEvents } = await setup(feed);
    const out = await syncGoogleFeed(deps);
    expect(out).toMatchObject({ kind: 'ok', events: 2, todosCreated: 1 });
    expect(await googleEvents()).toEqual([
      '2026-10-12 Supervision',
      '2026-10-15 ⏰ Steuer abgeben',
    ]);
    expect(todos.tasks.get(alarmTodoId('b'))).toEqual({
      title: 'Steuer abgeben',
      due: '2026-10-15',
      done: false,
    });
  });

  it('is idempotent: a second run creates nothing and writes nothing', async () => {
    const feed = { current: ics(['b', '20261015', '⏰ Steuer']) };
    const { deps, todos, storage } = await setup(feed);
    await syncGoogleFeed(deps);
    const before = JSON.stringify([...storage.dump().entries()].filter(([k]) => k !== FEED_DOC));
    const out = await syncGoogleFeed(deps);
    expect(out).toMatchObject({ todosCreated: 0, todosUpdated: 0, todosRemoved: 0 });
    expect(JSON.stringify([...storage.dump().entries()].filter(([k]) => k !== FEED_DOC))).toBe(
      before,
    );
    expect(todos.tasks.size).toBe(1);
  });

  it('moves the to-do with the appointment and removes it when the appointment is deleted', async () => {
    const feed = { current: ics(['b', '20261015', '⏰ Steuer']) };
    const { deps, todos, googleEvents } = await setup(feed);
    await syncGoogleFeed(deps);
    feed.current = ics(['b', '20261020', '⏰ Steuer']);
    expect(await syncGoogleFeed(deps)).toMatchObject({ todosUpdated: 1 });
    expect(todos.tasks.get(alarmTodoId('b'))?.due).toBe('2026-10-20');
    feed.current = ics();
    expect(await syncGoogleFeed(deps)).toMatchObject({ todosRemoved: 1 });
    expect(todos.tasks.size).toBe(0);
    expect(await googleEvents()).toEqual([]);
  });

  it('keeps a ticked-off to-do when the appointment disappears', async () => {
    const feed = { current: ics(['b', '20261015', '⏰ Steuer']) };
    const { deps, todos } = await setup(feed);
    await syncGoogleFeed(deps);
    todos.tasks.get(alarmTodoId('b'))!.done = true;
    feed.current = ics();
    await syncGoogleFeed(deps);
    expect(todos.tasks.get(alarmTodoId('b'))?.done).toBe(true);
  });

  it('never recreates a to-do the user deleted by hand', async () => {
    const feed = { current: ics(['b', '20261015', '⏰ Steuer']) };
    const { deps, todos } = await setup(feed);
    await syncGoogleFeed(deps);
    todos.tasks.delete(alarmTodoId('b'));
    await syncGoogleFeed(deps);
    expect(todos.tasks.size).toBe(0);
  });

  it('removes the to-do when ⏰ is taken out of the title', async () => {
    const feed = { current: ics(['b', '20261015', '⏰ Steuer']) };
    const { deps, todos } = await setup(feed);
    await syncGoogleFeed(deps);
    feed.current = ics(['b', '20261015', 'Steuer']);
    await syncGoogleFeed(deps);
    expect(todos.tasks.size).toBe(0);
  });

  it('ignores past ⏰ appointments and far-off repeats', async () => {
    const feed = {
      current: ics(
        ['past', '20261001', '⏰ Schon vorbei'],
        ['rep', '20261009', '⏰ Medikamente bestellen', ['RRULE:FREQ=MONTHLY']],
      ),
    };
    const { deps, todos } = await setup(feed);
    await syncGoogleFeed(deps);
    // Only the October 9 repeat is within 14 days; November's comes later.
    expect([...todos.tasks.values()].map((t) => t.due)).toEqual(['2026-10-09']);
  });

  it('respects the ⏰ switch and reports errors without touching data', async () => {
    const feed = { current: ics(['b', '20261015', '⏰ Steuer']) };
    const { deps, todos, storage, googleEvents } = await setup(feed);
    await storage.set(FEED_DOC, { url: URL, alarmTodos: false });
    await syncGoogleFeed(deps);
    expect(todos.tasks.size).toBe(0);
    expect(await googleEvents()).toHaveLength(1);
    const failing = { ...deps, fetchIcs: async () => Promise.reject(new Error('HTTP 404')) };
    expect(await syncGoogleFeed(failing)).toEqual({ kind: 'error', message: 'HTTP 404' });
    expect(await googleEvents()).toHaveLength(1);
    expect((await storage.get<{ lastError?: string }>(FEED_DOC))?.lastError).toBe('HTTP 404');
  });

  it('does nothing without an address or outside the desktop host', async () => {
    const { deps, storage } = await setup({ current: ics() });
    expect(await syncGoogleFeed({ ...deps, fetchIcs: undefined })).toEqual({ kind: 'no-host' });
    await storage.set(FEED_DOC, { url: 'https://example.com/x.ics' });
    expect(await syncGoogleFeed(deps)).toEqual({ kind: 'not-configured' });
  });

  it('unsubscribing removes mirrored appointments but keeps to-dos', async () => {
    const feed = { current: ics(['b', '20261015', '⏰ Steuer']) };
    const { deps, todos, storage, googleEvents } = await setup(feed);
    await syncGoogleFeed(deps);
    await removeGoogleFeed(storage);
    expect(await googleEvents()).toEqual([]);
    expect(await storage.get(FEED_DOC)).toBeNull();
    expect(todos.tasks.size).toBe(1);
  });
});
