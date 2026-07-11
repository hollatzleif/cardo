import { describe, expect, it } from 'vitest';
import {
  isOverdue,
  isValidDue,
  makeId,
  makeTask,
  priorityToken,
  sortCompletedTasks,
  sortOpenTasks,
  todayIso,
  type TaskDoc,
} from './logic';

function task(overrides: Partial<TaskDoc>): TaskDoc {
  return {
    ...makeTask({ title: 'x', list: 'list:inbox' }, new Date('2026-07-01T10:00:00Z')),
    ...overrides,
  };
}

describe('makeTask', () => {
  it('applies defaults and stores the id inside the doc', () => {
    const t = makeTask({ title: '  Buy milk  ', list: 'list:inbox' }, new Date('2026-07-01T10:00:00Z'));
    expect(t.id.startsWith('task:')).toBe(true);
    expect(t.title).toBe('Buy milk');
    expect(t.priority).toBe('medium');
    expect(t.done).toBe(false);
    expect(t.createdAt).toBe('2026-07-01T10:00:00.000Z');
    expect(t.completedAt).toBeNull();
    expect(t.category).toBeUndefined();
    expect(t.due).toBeUndefined();
  });

  it('keeps optional fields when provided', () => {
    const t = makeTask({ title: 'a', list: 'l', priority: 'high', category: ' work ', due: '2026-07-20' });
    expect(t.priority).toBe('high');
    expect(t.category).toBe('work');
    expect(t.due).toBe('2026-07-20');
  });
});

describe('makeId', () => {
  it('is prefixed and unique', () => {
    const ids = new Set(Array.from({ length: 100 }, () => makeId('task')));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id.startsWith('task:')).toBe(true);
  });
});

describe('isValidDue', () => {
  it('accepts real ISO dates', () => {
    expect(isValidDue('2026-07-11')).toBe(true);
    expect(isValidDue('2024-02-29')).toBe(true);
  });
  it('rejects malformed or impossible dates', () => {
    expect(isValidDue('11.07.2026')).toBe(false);
    expect(isValidDue('2026-7-1')).toBe(false);
    expect(isValidDue('2026-13-01')).toBe(false);
    expect(isValidDue('2026-02-30')).toBe(false);
  });
});

describe('todayIso / isOverdue', () => {
  it('formats local dates as yyyy-mm-dd', () => {
    expect(todayIso(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
  it('flags past due dates on open tasks only', () => {
    const today = '2026-07-11';
    expect(isOverdue({ due: '2026-07-10', done: false }, today)).toBe(true);
    expect(isOverdue({ due: '2026-07-11', done: false }, today)).toBe(false);
    expect(isOverdue({ due: '2026-07-12', done: false }, today)).toBe(false);
    expect(isOverdue({ due: '2026-07-01', done: true }, today)).toBe(false);
    expect(isOverdue({ done: false }, today)).toBe(false);
  });
});

describe('priorityToken', () => {
  it('maps priorities to semantic tokens', () => {
    expect(priorityToken('high')).toBe('danger');
    expect(priorityToken('medium')).toBe('warning');
    expect(priorityToken('low')).toBe('text-muted');
  });
});

describe('sortOpenTasks', () => {
  it('orders by priority, then due date (missing last), then createdAt', () => {
    const lowNoDue = task({ id: 'task:1', priority: 'low' });
    const highLate = task({ id: 'task:2', priority: 'high', due: '2026-08-01' });
    const highEarly = task({ id: 'task:3', priority: 'high', due: '2026-07-01' });
    const highNoDue = task({ id: 'task:4', priority: 'high' });
    const mediumOld = task({ id: 'task:5', priority: 'medium', createdAt: '2026-01-01T00:00:00.000Z' });
    const mediumNew = task({ id: 'task:6', priority: 'medium', createdAt: '2026-06-01T00:00:00.000Z' });

    const sorted = sortOpenTasks([lowNoDue, mediumNew, highLate, mediumOld, highNoDue, highEarly]);
    expect(sorted.map((t) => t.id)).toEqual(['task:3', 'task:2', 'task:4', 'task:5', 'task:6', 'task:1']);
  });
});

describe('sortCompletedTasks', () => {
  it('puts the most recently completed first', () => {
    const a = task({ id: 'task:a', done: true, completedAt: '2026-07-01T00:00:00.000Z' });
    const b = task({ id: 'task:b', done: true, completedAt: '2026-07-05T00:00:00.000Z' });
    const c = task({ id: 'task:c', done: true, completedAt: '2026-07-03T00:00:00.000Z' });
    expect(sortCompletedTasks([a, b, c]).map((t) => t.id)).toEqual(['task:b', 'task:c', 'task:a']);
  });
});
