import { describe, expect, it } from 'vitest';
import {
  addObjectiveParamsSchema,
  buildOkrContext,
  formatKr,
  krProgress,
  leastProgressed,
  makeKeyResult,
  makeObjective,
  matchKeyResult,
  matchObjective,
  objectiveProgress,
  sortObjectives,
  updateKrParamsSchema,
  type KeyResult,
  type ObjectiveDoc,
} from './logic';

function kr(partial: Partial<KeyResult>): KeyResult {
  return { id: `kr:${partial.title ?? 'test'}`, title: 'KR', current: 0, target: 10, ...partial };
}

function objective(partial: Partial<ObjectiveDoc>): ObjectiveDoc {
  return {
    id: `objective:${partial.title ?? 'test'}`,
    type: 'objective',
    title: 'Test objective',
    keyResults: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('krProgress', () => {
  it('is current/target for the normal case', () => {
    expect(krProgress(kr({ current: 3, target: 5 }))).toBe(0.6);
    expect(krProgress(kr({ current: 0, target: 5 }))).toBe(0);
  });

  it('target 0 or negative → 0 (never a division by zero)', () => {
    expect(krProgress(kr({ current: 3, target: 0 }))).toBe(0);
    expect(krProgress(kr({ current: 3, target: -5 }))).toBe(0);
  });

  it('negative current clamps to 0', () => {
    expect(krProgress(kr({ current: -2, target: 5 }))).toBe(0);
  });

  it('overachievement clamps to 1', () => {
    expect(krProgress(kr({ current: 12, target: 5 }))).toBe(1);
    expect(krProgress(kr({ current: 5, target: 5 }))).toBe(1);
  });

  it('non-finite values are 0', () => {
    expect(krProgress(kr({ current: Number.NaN, target: 5 }))).toBe(0);
    expect(krProgress(kr({ current: 3, target: Number.POSITIVE_INFINITY }))).toBe(0);
  });
});

describe('objectiveProgress', () => {
  it('averages the KR progresses', () => {
    const o = objective({
      keyResults: [kr({ id: 'kr:a', current: 5, target: 5 }), kr({ id: 'kr:b', current: 0, target: 5 })],
    });
    expect(objectiveProgress(o)).toBe(0.5);
  });

  it('is 0 without key results', () => {
    expect(objectiveProgress(objective({}))).toBe(0);
  });

  it('clamped KRs keep the average in 0–1', () => {
    const o = objective({
      keyResults: [
        kr({ id: 'kr:over', current: 100, target: 5 }), // clamps to 1
        kr({ id: 'kr:neg', current: -3, target: 5 }), // clamps to 0
        kr({ id: 'kr:zero', current: 3, target: 0 }), // target 0 → 0
      ],
    });
    expect(objectiveProgress(o)).toBeCloseTo(1 / 3, 12);
  });
});

describe('formatKr', () => {
  it('renders "current/target unit"', () => {
    expect(formatKr(kr({ current: 3, target: 5, unit: 'Artikel' }))).toBe('3/5 Artikel');
    expect(formatKr(kr({ current: 3, target: 5 }))).toBe('3/5');
  });

  it('trims float noise and keeps sensible decimals', () => {
    expect(formatKr(kr({ current: 0.1 + 0.2, target: 1 }))).toBe('0.3/1');
    expect(formatKr(kr({ current: 2.5, target: 10, unit: 'km' }))).toBe('2.5/10 km');
  });
});

describe('leastProgressed / sortObjectives', () => {
  const done = objective({ id: 'objective:done', title: 'Done', keyResults: [kr({ current: 5, target: 5 })] });
  const half = objective({
    id: 'objective:half',
    title: 'Half',
    keyResults: [kr({ current: 1, target: 2 })],
  });
  const fresh = objective({ id: 'objective:fresh', title: 'Fresh', keyResults: [kr({ current: 0, target: 2 })] });

  it('finds the least progressed objective', () => {
    expect(leastProgressed([done, half, fresh])?.id).toBe('objective:fresh');
    expect(leastProgressed([])).toBeNull();
  });

  it('sorts ascending by progress without mutating', () => {
    const input = [done, fresh, half];
    expect(sortObjectives(input).map((o) => o.id)).toEqual([
      'objective:fresh',
      'objective:half',
      'objective:done',
    ]);
    expect(input[0]?.id).toBe('objective:done');
  });
});

describe('matchObjective / matchKeyResult', () => {
  const objectives = [
    objective({ id: 'objective:blog', title: 'Grow the blog' }),
    objective({ id: 'objective:fit', title: 'Get fit' }),
  ];

  it('matches by id, exact title and unique substring (case-insensitive)', () => {
    expect(matchObjective(objectives, 'objective:fit')?.id).toBe('objective:fit');
    expect(matchObjective(objectives, 'GET FIT')?.id).toBe('objective:fit');
    expect(matchObjective(objectives, 'blog')?.id).toBe('objective:blog');
  });

  it('returns null for unknown, empty and ambiguous references', () => {
    expect(matchObjective(objectives, 'nope')).toBeNull();
    expect(matchObjective(objectives, '  ')).toBeNull();
    expect(matchObjective(objectives, 'g')).toBeNull(); // ambiguous
  });

  it('finds key results the same way', () => {
    const o = objective({
      keyResults: [kr({ id: 'kr:posts', title: 'Publish posts' }), kr({ id: 'kr:subs', title: 'Subscribers' })],
    });
    expect(matchKeyResult(o, 'kr:subs')?.id).toBe('kr:subs');
    expect(matchKeyResult(o, 'publish posts')?.id).toBe('kr:posts');
    expect(matchKeyResult(o, 'subs')?.id).toBe('kr:subs');
    expect(matchKeyResult(o, 's')).toBeNull(); // ambiguous
  });
});

describe('makeObjective / makeKeyResult', () => {
  it('trims and drops empty quarter/unit', () => {
    const o = makeObjective({ title: '  Ship it  ', quarter: ' ' });
    expect(o.title).toBe('Ship it');
    expect(o.quarter).toBeUndefined();
    expect(o.type).toBe('objective');
    expect(o.keyResults).toEqual([]);
    const withQuarter = makeObjective({ title: 'X', quarter: ' Q3 2026 ' });
    expect(withQuarter.quarter).toBe('Q3 2026');
    const k = makeKeyResult({ title: ' Posts ', target: 5, unit: ' ' });
    expect(k.title).toBe('Posts');
    expect(k.current).toBe(0);
    expect(k.target).toBe(5);
    expect(k.unit).toBeUndefined();
  });
});

describe('param schemas', () => {
  it('validates command params', () => {
    expect(addObjectiveParamsSchema.safeParse({ title: 'X' }).success).toBe(true);
    expect(addObjectiveParamsSchema.safeParse({ title: 'X', quarter: 'Q3 2026' }).success).toBe(true);
    expect(addObjectiveParamsSchema.safeParse({ title: '' }).success).toBe(false);
    expect(
      updateKrParamsSchema.safeParse({ objective: 'X', keyResult: 'Y', current: 3 }).success,
    ).toBe(true);
    expect(
      updateKrParamsSchema.safeParse({ objective: 'X', keyResult: 'Y', current: Number.NaN }).success,
    ).toBe(false);
    expect(updateKrParamsSchema.safeParse({ objective: 'X', keyResult: 'Y' }).success).toBe(false);
  });
});

describe('buildOkrContext', () => {
  it('reports the empty state in both languages', () => {
    expect(buildOkrContext([], 'en')).toBe('No objectives yet.');
    expect(buildOkrContext([], 'de')).toBe('Keine Objectives angelegt.');
  });

  it('lists percentage, quarter and formatted KRs', () => {
    const o = objective({
      title: 'Grow the blog',
      quarter: 'Q3 2026',
      keyResults: [kr({ id: 'kr:a', title: 'Artikel', current: 3, target: 5, unit: 'Artikel' })],
    });
    const text = buildOkrContext([o], 'de');
    expect(text).toContain('1 Objectives.');
    expect(text).toContain('«Grow the blog» [Q3 2026]: 60%');
    expect(text).toContain('«Artikel» 3/5 Artikel (60%)');
  });

  it('mentions objectives without key results', () => {
    const text = buildOkrContext([objective({ title: 'Empty' })], 'en');
    expect(text).toContain('«Empty»: 0% – no key results yet');
  });
});
