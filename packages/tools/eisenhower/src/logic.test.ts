import { describe, expect, it } from 'vitest';
import {
  QUADRANTS,
  buildEisenhowerContext,
  groupByQuadrant,
  makeId,
  makeTask,
  moveTask,
  quadrantToken,
  setDone,
  sortTasks,
  type Quadrant,
  type TaskDoc,
} from './logic';

function task(overrides: Partial<TaskDoc>): TaskDoc {
  return {
    ...makeTask({ title: 'x', quadrant: 'q1' }, new Date('2026-07-01T10:00:00Z')),
    ...overrides,
  };
}

describe('makeTask / makeId', () => {
  it('applies defaults and stores the id inside the doc', () => {
    const t = makeTask({ title: '  Call the bank  ', quadrant: 'q2' }, new Date('2026-07-01T10:00:00Z'));
    expect(t.id.startsWith('task:')).toBe(true);
    expect(t.type).toBe('task');
    expect(t.title).toBe('Call the bank');
    expect(t.quadrant).toBe('q2');
    expect(t.done).toBe(false);
    expect(t.createdAt).toBe('2026-07-01T10:00:00.000Z');
  });

  it('generates unique prefixed ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => makeId()));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id.startsWith('task:')).toBe(true);
  });
});

describe('moveTask', () => {
  it('moves a task to another quadrant without mutating the original', () => {
    const original = task({ quadrant: 'q1' });
    const moved = moveTask(original, 'q3');
    expect(moved.quadrant).toBe('q3');
    expect(original.quadrant).toBe('q1');
    expect(moved).not.toBe(original);
    expect(moved.id).toBe(original.id);
    expect(moved.title).toBe(original.title);
  });

  it('returns the same object for a no-op move', () => {
    const original = task({ quadrant: 'q4' });
    expect(moveTask(original, 'q4')).toBe(original);
  });

  it('supports every quadrant', () => {
    for (const quadrant of QUADRANTS) {
      expect(moveTask(task({ quadrant: 'q1' }), quadrant).quadrant).toBe(quadrant);
    }
  });
});

describe('setDone', () => {
  it('toggles the done flag immutably', () => {
    const original = task({ done: false });
    const completed = setDone(original, true);
    expect(completed.done).toBe(true);
    expect(original.done).toBe(false);
    expect(setDone(completed, false).done).toBe(false);
  });

  it('returns the same object when nothing changes', () => {
    const original = task({ done: true });
    expect(setDone(original, true)).toBe(original);
  });
});

describe('groupByQuadrant', () => {
  it('buckets tasks into all four quadrants', () => {
    const q1 = task({ id: 'task:a', quadrant: 'q1' });
    const q3a = task({ id: 'task:b', quadrant: 'q3' });
    const q3b = task({ id: 'task:c', quadrant: 'q3' });
    const groups = groupByQuadrant([q1, q3a, q3b]);
    expect(groups.q1.map((t) => t.id)).toEqual(['task:a']);
    expect(groups.q2).toEqual([]);
    expect(groups.q3.map((t) => t.id).sort()).toEqual(['task:b', 'task:c']);
    expect(groups.q4).toEqual([]);
  });

  it('sorts each bucket: open (oldest first) before done', () => {
    const done = task({ id: 'task:done', done: true, createdAt: '2026-01-01T00:00:00.000Z' });
    const oldOpen = task({ id: 'task:old', createdAt: '2026-02-01T00:00:00.000Z' });
    const newOpen = task({ id: 'task:new', createdAt: '2026-03-01T00:00:00.000Z' });
    const groups = groupByQuadrant([done, newOpen, oldOpen]);
    expect(groups.q1.map((t) => t.id)).toEqual(['task:old', 'task:new', 'task:done']);
  });
});

describe('sortTasks', () => {
  it('filters nothing but pushes completed tasks to the end', () => {
    const a = task({ id: 'task:a', done: true });
    const b = task({ id: 'task:b', done: false });
    const sorted = sortTasks([a, b]);
    expect(sorted.map((t) => t.id)).toEqual(['task:b', 'task:a']);
    expect(sorted).toHaveLength(2);
  });
});

describe('quadrantToken', () => {
  it('maps each quadrant to its chart token', () => {
    const expected: Record<Quadrant, string> = {
      q1: 'chart-1',
      q2: 'chart-2',
      q3: 'chart-3',
      q4: 'chart-4',
    };
    for (const quadrant of QUADRANTS) expect(quadrantToken(quadrant)).toBe(expected[quadrant]);
  });
});

describe('buildEisenhowerContext', () => {
  it('reports an empty matrix in both languages', () => {
    expect(buildEisenhowerContext([], 'en')).toBe('The Eisenhower matrix is empty.');
    expect(buildEisenhowerContext([], 'de')).toBe('Die Eisenhower-Matrix ist leer.');
  });

  it('lists open tasks grouped by quadrant', () => {
    const text = buildEisenhowerContext(
      [
        task({ title: 'File taxes', quadrant: 'q1' }),
        task({ title: 'Plan vacation', quadrant: 'q2' }),
      ],
      'en',
    );
    expect(text).toContain('Q1 (urgent & important): «File taxes»');
    expect(text).toContain('Q2 (important, not urgent): «Plan vacation»');
  });

  it('excludes completed tasks from the listing but counts them', () => {
    const text = buildEisenhowerContext(
      [task({ title: 'Old chore', quadrant: 'q4', done: true })],
      'en',
    );
    expect(text).not.toContain('Old chore');
    expect(text).toContain('1 completed');
  });

  it('speaks informal German', () => {
    const text = buildEisenhowerContext(
      [
        task({ title: 'Steuer', quadrant: 'q3' }),
        task({ title: 'Fertig', quadrant: 'q1', done: true }),
      ],
      'de',
    );
    expect(text).toContain('Q3 (dringend, nicht wichtig): «Steuer»');
    expect(text).toContain('1 erledigt');
  });

  it('caps each quadrant listing at 10 titles', () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      task({ id: `task:${i}`, title: `Task ${i}`, quadrant: 'q1' }),
    );
    const text = buildEisenhowerContext(many, 'en');
    expect(text).toContain('«Task 9»');
    expect(text).not.toContain('«Task 10»');
  });
});
