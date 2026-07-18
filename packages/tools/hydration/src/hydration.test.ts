import { describe, expect, it } from 'vitest';
import type { CommandSpec, ToolContext } from '@cardo/plugin-api';
import { isInWindow, localDateKey } from './hydration';
import { createTool } from './index';

/** Stateful fake host context: a scheduler that really tracks entries so the
 *  reminder de-dup (anti-spam) invariant can be exercised end-to-end. */
function harness() {
  const docs = new Map<string, Record<string, unknown>>();
  const schedules = new Map<string, { when: string; commandId: string }>();
  const registered = new Map<string, CommandSpec<unknown>>();
  let n = 0;
  const ctx = {
    storage: {
      get: async (id: string) => (docs.get(id) as never) ?? null,
      set: async (id: string, v: Record<string, unknown>) => void docs.set(id, v),
      delete: async (id: string) => void docs.delete(id),
      query: async () => [...docs.values()] as never[],
      subscribe: () => () => {},
    },
    scheduler: {
      scheduleAt: async (when: Date, commandId: string) => {
        const id = `s${(n += 1)}`;
        schedules.set(id, { when: when.toISOString(), commandId });
        return id;
      },
      cancel: async (id: string) => void schedules.delete(id),
      list: async () => [...schedules.entries()].map(([id, e]) => ({ id, ...e })),
    },
    notifications: { notify: async () => {} },
    settings: { get: async () => null, set: async () => {}, subscribe: () => () => {} },
    i18n: { t: (k: string) => k, language: 'de' },
    commands: {
      register: (s: CommandSpec<unknown>) => void registered.set(s.id, s),
      execute: async () => ({ ok: true }),
      has: () => false,
    },
    events: { emit: () => {}, on: () => () => {} },
    theme: { token: (x: string) => x, semantic: () => '' },
    search: { register: () => {} },
  } as unknown as ToolContext;
  return { ctx, schedules, registered };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const pending = (s: Map<string, { commandId: string }>): number =>
  [...s.values()].filter((e) => e.commandId === 'hydration.remind').length;

describe('reminder de-duplication (anti-spam regression, blocker #3)', () => {
  it('keeps exactly one pending reminder no matter how often it re-arms', async () => {
    const tool = createTool();
    const { ctx, schedules, registered } = harness();
    await tool.activate(ctx);
    await flush();
    const remind = registered.get('hydration.remind')!;
    await remind.run({});
    await remind.run({});
    await remind.run({});
    await flush();
    expect(pending(schedules)).toBe(1);
  });

  it('heals an installation that already stacked duplicate reminders', async () => {
    const tool = createTool();
    const { ctx, schedules, registered } = harness();
    await tool.activate(ctx);
    await flush();
    schedules.set('orphan1', { when: '', commandId: 'hydration.remind' });
    schedules.set('orphan2', { when: '', commandId: 'hydration.remind' });
    schedules.set('orphan3', { when: '', commandId: 'hydration.remind' });
    await registered.get('hydration.remind')!.run({});
    await flush();
    // The sweep cancels all orphans and arms exactly one fresh reminder.
    expect(pending(schedules)).toBe(1);
  });
});

describe('localDateKey', () => {
  it('formats a local date as YYYY-MM-DD with zero padding', () => {
    expect(localDateKey(new Date(2026, 2, 5, 12, 0, 0))).toBe('2026-03-05');
    expect(localDateKey(new Date(2026, 10, 30, 12, 0, 0))).toBe('2026-11-30');
  });

  it('uses the LOCAL day, even right after local midnight', () => {
    expect(localDateKey(new Date(2026, 0, 1, 0, 30, 0))).toBe('2026-01-01');
    expect(localDateKey(new Date(2026, 11, 31, 23, 30, 0))).toBe('2026-12-31');
  });
});

describe('isInWindow', () => {
  const at = (h: number, m: number) => new Date(2026, 0, 15, h, m, 0);

  it('accepts times inside a same-day window (inclusive bounds)', () => {
    expect(isInWindow(at(9, 0), '09:00', '21:00')).toBe(true);
    expect(isInWindow(at(12, 30), '09:00', '21:00')).toBe(true);
    expect(isInWindow(at(21, 0), '09:00', '21:00')).toBe(true);
  });

  it('rejects times outside a same-day window', () => {
    expect(isInWindow(at(8, 59), '09:00', '21:00')).toBe(false);
    expect(isInWindow(at(21, 1), '09:00', '21:00')).toBe(false);
    expect(isInWindow(at(0, 0), '09:00', '21:00')).toBe(false);
  });

  it('supports windows crossing midnight (22:00–06:00)', () => {
    expect(isInWindow(at(22, 0), '22:00', '06:00')).toBe(true);
    expect(isInWindow(at(23, 59), '22:00', '06:00')).toBe(true);
    expect(isInWindow(at(0, 30), '22:00', '06:00')).toBe(true);
    expect(isInWindow(at(6, 0), '22:00', '06:00')).toBe(true);
    expect(isInWindow(at(6, 1), '22:00', '06:00')).toBe(false);
    expect(isInWindow(at(12, 0), '22:00', '06:00')).toBe(false);
    expect(isInWindow(at(21, 59), '22:00', '06:00')).toBe(false);
  });

  it('treats from === until as a 24h window', () => {
    expect(isInWindow(at(0, 0), '09:00', '09:00')).toBe(true);
    expect(isInWindow(at(17, 45), '09:00', '09:00')).toBe(true);
  });

  it('fails open on malformed times (reminders keep working)', () => {
    expect(isInWindow(at(3, 0), 'nonsense', '21:00')).toBe(true);
    expect(isInWindow(at(3, 0), '09:00', '25:99')).toBe(true);
  });
});
