import { describe, expect, it } from 'vitest';
import {
  addGoalParamsSchema,
  buildSavingsContext,
  contributeParamsSchema,
  daysUntil,
  formatMoney,
  isValidDeadline,
  makeGoal,
  neededPerDay,
  onTrack,
  progressOf,
  todayIso,
  type GoalDoc,
} from './logic';

function goal(partial: Partial<GoalDoc>): GoalDoc {
  return {
    id: 'goal:test',
    type: 'goal',
    name: 'Test goal',
    target: 100,
    saved: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('progressOf', () => {
  it('reports the saved fraction', () => {
    expect(progressOf({ target: 200, saved: 50 })).toBe(0.25);
    expect(progressOf({ target: 100, saved: 100 })).toBe(1);
  });

  it('guards target <= 0 (no division by zero)', () => {
    expect(progressOf({ target: 0, saved: 50 })).toBe(0);
    expect(progressOf({ target: -5, saved: 50 })).toBe(0);
  });

  it('clamps to 0..1', () => {
    expect(progressOf({ target: 100, saved: 150 })).toBe(1);
    expect(progressOf({ target: 100, saved: -10 })).toBe(0);
  });
});

describe('daysUntil', () => {
  it('counts whole days between yyyy-mm-dd dates', () => {
    expect(daysUntil('2026-07-20', '2026-07-15')).toBe(5);
    expect(daysUntil('2026-07-15', '2026-07-15')).toBe(0);
    expect(daysUntil('2026-07-10', '2026-07-15')).toBe(-5);
  });

  it('handles month and leap-year boundaries', () => {
    expect(daysUntil('2024-03-01', '2024-02-28')).toBe(2); // 2024 is a leap year
    expect(daysUntil('2026-03-01', '2026-02-28')).toBe(1);
  });
});

describe('neededPerDay', () => {
  const today = '2026-07-15';

  it('is 0 without a deadline', () => {
    expect(neededPerDay(goal({ target: 100, saved: 10 }), today)).toBe(0);
  });

  it('is 0 for past deadlines', () => {
    expect(neededPerDay(goal({ target: 100, saved: 10, deadline: '2026-07-14' }), today)).toBe(0);
  });

  it('is 0 once the target is reached (or exceeded)', () => {
    expect(neededPerDay(goal({ target: 100, saved: 100, deadline: '2026-08-01' }), today)).toBe(0);
    expect(neededPerDay(goal({ target: 100, saved: 150, deadline: '2026-08-01' }), today)).toBe(0);
  });

  it('divides the remaining amount over the remaining days', () => {
    expect(neededPerDay(goal({ target: 100, saved: 50, deadline: '2026-07-25' }), today)).toBe(5);
  });

  it('a deadline of today means "the rest today" – never a division by zero', () => {
    expect(neededPerDay(goal({ target: 100, saved: 40, deadline: today }), today)).toBe(60);
  });

  it('target 0 never produces a rate', () => {
    expect(neededPerDay(goal({ target: 0, saved: 0, deadline: '2026-08-01' }), today)).toBe(0);
  });
});

describe('onTrack', () => {
  // Created 2026-01-01, due 2026-01-11 → 100 target over 10 days = 10/day.
  const base = goal({ target: 100, deadline: '2026-01-11' });

  it('is true without a deadline or once the goal is reached', () => {
    expect(onTrack(goal({ saved: 0 }), '2026-07-15')).toBe(true);
    expect(onTrack(goal({ saved: 100, deadline: '2026-01-02' }), '2026-07-15')).toBe(true);
  });

  it('follows the linear schedule between creation and deadline', () => {
    expect(onTrack({ ...base, saved: 50 }, '2026-01-06')).toBe(true); // exactly on schedule
    expect(onTrack({ ...base, saved: 60 }, '2026-01-06')).toBe(true); // ahead
    expect(onTrack({ ...base, saved: 49 }, '2026-01-06')).toBe(false); // behind
  });

  it('a passed deadline without reaching the target is never on track', () => {
    expect(onTrack({ ...base, saved: 99 }, '2026-01-12')).toBe(false);
  });

  it('a deadline on/before the creation day expects the full amount immediately', () => {
    const sameDay = goal({ target: 100, saved: 50, deadline: '2026-01-01' });
    expect(onTrack(sameDay, '2026-01-01')).toBe(false);
    expect(onTrack({ ...sameDay, saved: 100 }, '2026-01-01')).toBe(true);
  });

  it('is true for target <= 0', () => {
    expect(onTrack(goal({ target: 0, deadline: '2026-01-11' }), '2026-01-06')).toBe(true);
  });
});

describe('makeGoal', () => {
  it('trims the name, starts at 0 saved and omits an absent deadline', () => {
    const g = makeGoal({ name: '  Bike  ', target: 500 }, new Date('2026-07-15T10:00:00Z'));
    expect(g.name).toBe('Bike');
    expect(g.saved).toBe(0);
    expect(g.target).toBe(500);
    expect(g.type).toBe('goal');
    expect(g.id.startsWith('goal:')).toBe(true);
    expect('deadline' in g).toBe(false);
    expect(g.createdAt).toBe('2026-07-15T10:00:00.000Z');
  });

  it('keeps a provided deadline', () => {
    expect(makeGoal({ name: 'X', target: 1, deadline: '2026-12-31' }).deadline).toBe('2026-12-31');
  });
});

describe('isValidDeadline', () => {
  it('accepts real yyyy-mm-dd dates', () => {
    expect(isValidDeadline('2026-07-15')).toBe(true);
    expect(isValidDeadline('2024-02-29')).toBe(true); // leap day
  });

  it('rejects malformed or impossible dates', () => {
    expect(isValidDeadline('2026-7-5')).toBe(false);
    expect(isValidDeadline('2026-13-01')).toBe(false);
    expect(isValidDeadline('2026-02-30')).toBe(false);
    expect(isValidDeadline('2026-02-29')).toBe(false); // 2026 is not a leap year
    expect(isValidDeadline('nope')).toBe(false);
  });
});

describe('command params schemas', () => {
  it('add-goal rejects zero/negative targets and empty names', () => {
    expect(addGoalParamsSchema.safeParse({ name: 'X', target: 100 }).success).toBe(true);
    expect(addGoalParamsSchema.safeParse({ name: 'X', target: 0 }).success).toBe(false);
    expect(addGoalParamsSchema.safeParse({ name: 'X', target: -5 }).success).toBe(false);
    expect(addGoalParamsSchema.safeParse({ name: '', target: 100 }).success).toBe(false);
    expect(
      addGoalParamsSchema.safeParse({ name: 'X', target: 100, deadline: 'not-a-date' }).success,
    ).toBe(false);
    expect(
      addGoalParamsSchema.safeParse({ name: 'X', target: 100, deadline: '2026-12-31' }).success,
    ).toBe(true);
  });

  it('contribute rejects zero/negative amounts', () => {
    expect(contributeParamsSchema.safeParse({ id: 'goal:a', amount: 5 }).success).toBe(true);
    expect(contributeParamsSchema.safeParse({ id: 'goal:a', amount: 0 }).success).toBe(false);
    expect(contributeParamsSchema.safeParse({ id: 'goal:a', amount: -5 }).success).toBe(false);
    expect(contributeParamsSchema.safeParse({ id: '', amount: 5 }).success).toBe(false);
  });
});

describe('formatMoney', () => {
  it('formats with the UI language and appends the currency symbol', () => {
    expect(formatMoney(1234.5, 'en', '€')).toBe('1,234.5 €');
    expect(formatMoney(1234.5, 'de', '€')).toBe('1.234,5 €');
    expect(formatMoney(10, 'en', '')).toBe('10');
  });
});

describe('todayIso', () => {
  it('renders the LOCAL date as yyyy-mm-dd', () => {
    expect(todayIso(new Date(2026, 6, 15, 12, 0, 0))).toBe('2026-07-15');
    expect(todayIso(new Date(2026, 0, 3, 0, 30, 0))).toBe('2026-01-03');
  });
});

describe('buildSavingsContext', () => {
  const today = '2026-01-06';

  it('reports the empty state in both languages', () => {
    expect(buildSavingsContext([], 'en', today)).toBe('No savings goals yet.');
    expect(buildSavingsContext([], 'de', today)).toBe('Keine Sparziele angelegt.');
  });

  it('lists name, id, amounts, percent, deadline and rate', () => {
    const g = goal({ id: 'goal:abc', name: 'Bike', target: 100, saved: 50, deadline: '2026-01-11' });
    const text = buildSavingsContext([g], 'en', today);
    expect(text).toContain('Savings goals:');
    expect(text).toContain('«Bike»');
    expect(text).toContain('(id goal:abc)');
    expect(text).toContain('50 / 100 (50 %)');
    expect(text).toContain('deadline 2026-01-11');
    expect(text).toContain('needs 10/day');
    expect(text).toContain('on track');
  });

  it('flags goals behind plan (German, informal wording)', () => {
    const g = goal({ name: 'Rad', target: 100, saved: 10, deadline: '2026-01-11' });
    const text = buildSavingsContext([g], 'de', today);
    expect(text).toContain('Sparziele:');
    expect(text).toContain('hinter dem Plan');
    expect(text).toContain('Frist 2026-01-11');
  });

  it('omits deadline details for goals without one', () => {
    const text = buildSavingsContext([goal({ name: 'Loose', saved: 5 })], 'en', today);
    expect(text).not.toContain('deadline');
    expect(text).not.toContain('/day');
  });
});
