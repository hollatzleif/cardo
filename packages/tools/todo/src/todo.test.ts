import { describe, expect, it } from 'vitest';
import {
  computeTodayData,
  deriveStatus,
  isOverdue,
  isValidDue,
  localDateOf,
  makeId,
  makeTask,
  matchesQuery,
  priorityToken,
  sortCompletedTasks,
  sortOpenTasks,
  todayIso,
  type ListDoc,
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

describe('deriveStatus', () => {
  it('derives "todo" for legacy open docs without a status field', () => {
    expect(deriveStatus({ done: false })).toBe('todo');
    expect(deriveStatus(makeTask({ title: 'x', list: 'l' }))).toBe('todo');
  });
  it('derives "done" for legacy done docs without a status field', () => {
    expect(deriveStatus({ done: true })).toBe('done');
  });
  it('done:true always wins over a stale status field', () => {
    expect(deriveStatus({ done: true, status: 'doing' })).toBe('done');
    expect(deriveStatus({ done: true, status: 'todo' })).toBe('done');
  });
  it('respects an explicit status on open tasks', () => {
    expect(deriveStatus({ done: false, status: 'doing' })).toBe('doing');
    expect(deriveStatus({ done: false, status: 'todo' })).toBe('todo');
  });
  it('normalizes an inconsistent open doc carrying status:"done" to "todo"', () => {
    expect(deriveStatus({ done: false, status: 'done' })).toBe('todo');
  });
});

describe('localDateOf', () => {
  it('returns the local calendar date of a timestamp', () => {
    // Local-time timestamp (no Z) → same calendar date in every timezone.
    expect(localDateOf('2026-07-05T12:34:56')).toBe('2026-07-05');
  });
});

describe('matchesQuery', () => {
  it('matches title and category case-insensitively', () => {
    const t = { title: 'Buy Milk', category: 'Errands' };
    expect(matchesQuery(t, 'milk')).toBe(true);
    expect(matchesQuery(t, 'BUY')).toBe(true);
    expect(matchesQuery(t, 'errand')).toBe(true);
    expect(matchesQuery(t, '  milk ')).toBe(true);
    expect(matchesQuery(t, 'bread')).toBe(false);
    expect(matchesQuery(t, '')).toBe(false);
    expect(matchesQuery({ title: 'a' }, 'x')).toBe(false);
  });
});

describe('computeTodayData', () => {
  const TODAY = '2026-07-11';
  const lists: Array<Pick<ListDoc, 'id' | 'name'>> = [
    { id: 'list:inbox', name: 'Inbox' },
    { id: 'list:work', name: 'Work' },
  ];

  it('collects overdue, due-today and open high-priority tasks in that order', () => {
    const overdueLow = task({ id: 'task:od', priority: 'low', due: '2026-07-09' });
    const dueTodayMed = task({ id: 'task:dt', priority: 'medium', due: TODAY });
    const highNoDue = task({ id: 'task:hi', priority: 'high', list: 'list:work' });
    const futureLow = task({ id: 'task:fu', priority: 'low', due: '2026-08-01' });
    const doneToday = task({ id: 'task:dn', done: true, status: 'done', completedAt: '2026-07-11T09:00:00' });
    const doneEarlier = task({ id: 'task:de', done: true, status: 'done', completedAt: '2026-07-01T09:00:00' });

    const data = computeTodayData([futureLow, doneEarlier, highNoDue, doneToday, dueTodayMed, overdueLow], lists, TODAY);
    expect(data.open.map((i) => i.id)).toEqual(['task:od', 'task:dt', 'task:hi']);
    expect(data.overdue).toBe(1);
    expect(data.dueToday).toBe(1);
    expect(data.completedToday).toBe(1);
  });

  it('maps item fields: list name, overdue flag, optional due', () => {
    const overdueTask = task({ id: 'task:od', title: 'pay bill', priority: 'high', due: '2026-07-01', list: 'list:work' });
    const highNoDue = task({ id: 'task:hi', title: 'plan', priority: 'high', list: 'list:unknown' });
    const data = computeTodayData([overdueTask, highNoDue], lists, TODAY);
    expect(data.open[0]).toEqual({
      id: 'task:od',
      title: 'pay bill',
      priority: 'high',
      due: '2026-07-01',
      list: 'Work',
      overdue: true,
    });
    // Unknown list ids fall back to the raw id; no due → no due key.
    expect(data.open[1]!.list).toBe('list:unknown');
    expect(data.open[1]!.overdue).toBe(false);
    expect('due' in data.open[1]!).toBe(false);
  });

  it('orders overdue before due-today before high priority, then by priority', () => {
    const odLow = task({ id: 'task:1', priority: 'low', due: '2026-07-10' });
    const odHigh = task({ id: 'task:2', priority: 'high', due: '2026-07-09' });
    const dtHigh = task({ id: 'task:3', priority: 'high', due: TODAY });
    const dtLow = task({ id: 'task:4', priority: 'low', due: TODAY });
    const hi = task({ id: 'task:5', priority: 'high' });
    const data = computeTodayData([hi, dtLow, odLow, dtHigh, odHigh], lists, TODAY);
    expect(data.open.map((i) => i.id)).toEqual(['task:2', 'task:1', 'task:3', 'task:4', 'task:5']);
  });

  it('caps the open list at 10 but counts everything', () => {
    const many = Array.from({ length: 14 }, (_, i) =>
      task({ id: `task:${i}`, priority: 'low', due: '2026-07-01' }),
    );
    const data = computeTodayData(many, lists, TODAY);
    expect(data.open).toHaveLength(10);
    expect(data.overdue).toBe(14);
  });

  it('ignores completed tasks for open/overdue/dueToday and future completions for completedToday', () => {
    const doneOverdue = task({ id: 'task:a', done: true, status: 'done', due: '2026-07-01', completedAt: '2026-07-10T08:00:00' });
    const data = computeTodayData([doneOverdue], lists, TODAY);
    expect(data.open).toHaveLength(0);
    expect(data.overdue).toBe(0);
    expect(data.dueToday).toBe(0);
    expect(data.completedToday).toBe(0);
  });
});
