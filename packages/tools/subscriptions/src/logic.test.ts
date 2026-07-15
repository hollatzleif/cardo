import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonthsClamped,
  addSubParamsSchema,
  advanceDue,
  buildSubsContext,
  daysInMonth,
  daysUntil,
  dueWithin,
  duesInMonth,
  formatMoney,
  isValidDate,
  makeSub,
  monthlyCost,
  todayIso,
  totalMonthly,
  type Cycle,
  type SubDoc,
} from './logic';

function sub(partial: Partial<SubDoc>): SubDoc {
  return {
    id: 'sub:test',
    type: 'sub',
    name: 'Test sub',
    amount: 10,
    cycle: 'monthly',
    nextDue: '2026-08-01',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('monthlyCost', () => {
  it('normalizes every cycle to a month', () => {
    expect(monthlyCost(12, 'weekly')).toBe(52); // 12 × 52 / 12
    expect(monthlyCost(9.99, 'monthly')).toBe(9.99);
    expect(monthlyCost(30, 'quarterly')).toBe(10);
    expect(monthlyCost(120, 'yearly')).toBe(10);
  });

  it('does NOT round per item (rounding happens once, at sum time)', () => {
    expect(monthlyCost(1, 'yearly')).toBeCloseTo(1 / 12, 12);
    expect(monthlyCost(1, 'quarterly')).toBeCloseTo(1 / 3, 12);
  });
});

describe('totalMonthly', () => {
  it('sums and rounds to cents exactly once', () => {
    // 3 × 1.00/year: per-item cent rounding would give 3 × 0.08 = 0.24.
    const subs = [
      sub({ amount: 1, cycle: 'yearly' }),
      sub({ amount: 1, cycle: 'yearly' }),
      sub({ amount: 1, cycle: 'yearly' }),
    ];
    expect(totalMonthly(subs)).toBe(0.25);
  });

  it('handles mixed cycles exactly', () => {
    const subs = [
      sub({ amount: 5, cycle: 'monthly' }), // 5
      sub({ amount: 120, cycle: 'yearly' }), // 10
      sub({ amount: 3, cycle: 'weekly' }), // 13 (3 × 52 / 12)
      sub({ amount: 30, cycle: 'quarterly' }), // 10
    ];
    expect(totalMonthly(subs)).toBe(38);
  });

  it('is 0 for no subscriptions', () => {
    expect(totalMonthly([])).toBe(0);
  });
});

describe('calendar math', () => {
  it('daysInMonth knows leap years', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  it('addDays crosses month and year boundaries', () => {
    expect(addDays('2026-12-30', 7)).toBe('2027-01-06');
    expect(addDays('2026-07-15', 0)).toBe('2026-07-15');
  });

  it('addMonthsClamped clamps into shorter months and honors the anchor', () => {
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsClamped('2024-01-31', 1)).toBe('2024-02-29'); // leap year
    expect(addMonthsClamped('2026-01-31', 2, 31)).toBe('2026-03-31'); // anchor survives Feb
    expect(addMonthsClamped('2026-11-15', 3)).toBe('2027-02-15'); // year rollover
  });

  it('daysUntil counts calendar days', () => {
    expect(daysUntil('2026-07-22', '2026-07-15')).toBe(7);
    expect(daysUntil('2026-07-10', '2026-07-15')).toBe(-5);
  });
});

describe('advanceDue', () => {
  it('leaves future due dates untouched', () => {
    const s = sub({ nextDue: '2026-08-01' });
    expect(advanceDue(s, '2026-07-15').nextDue).toBe('2026-08-01');
  });

  it('advances a due date of today (strictly after today)', () => {
    expect(advanceDue(sub({ nextDue: '2026-07-15', cycle: 'monthly' }), '2026-07-15').nextDue).toBe(
      '2026-08-15',
    );
  });

  it('weekly steps in 7-day increments past today', () => {
    expect(advanceDue(sub({ nextDue: '2026-07-01', cycle: 'weekly' }), '2026-07-15').nextDue).toBe(
      '2026-07-22',
    );
  });

  it('monthly clamps Jan 31 → Feb 28 but keeps the 31st as anchor', () => {
    const s = sub({ nextDue: '2026-01-31', cycle: 'monthly' });
    expect(advanceDue(s, '2026-02-01').nextDue).toBe('2026-02-28');
    expect(advanceDue(s, '2026-02-28').nextDue).toBe('2026-03-31'); // back on the 31st
  });

  it('respects leap years', () => {
    expect(advanceDue(sub({ nextDue: '2024-01-31', cycle: 'monthly' }), '2024-02-01').nextDue).toBe(
      '2024-02-29',
    );
    expect(advanceDue(sub({ nextDue: '2024-02-29', cycle: 'yearly' }), '2024-03-01').nextDue).toBe(
      '2025-02-28',
    );
  });

  it('quarterly adds three months per step', () => {
    expect(
      advanceDue(sub({ nextDue: '2026-01-15', cycle: 'quarterly' }), '2026-04-20').nextDue,
    ).toBe('2026-07-15');
  });

  it('catches up over several missed cycles in one call', () => {
    expect(advanceDue(sub({ nextDue: '2026-01-10', cycle: 'monthly' }), '2026-07-15').nextDue).toBe(
      '2026-08-10',
    );
  });

  it('returns invalid docs unchanged', () => {
    expect(advanceDue(sub({ nextDue: 'garbage' }), '2026-07-15').nextDue).toBe('garbage');
  });
});

describe('dueWithin', () => {
  const today = '2026-07-15';
  const a = sub({ id: 'sub:a', name: 'A', nextDue: '2026-07-16' });
  const b = sub({ id: 'sub:b', name: 'B', nextDue: '2026-07-25' });
  const c = sub({ id: 'sub:c', name: 'C', nextDue: '2026-07-10' }); // overdue
  const d = sub({ id: 'sub:d', name: 'D', nextDue: '2026-08-30' });

  it('includes overdue and near dues, sorted by date', () => {
    expect(dueWithin([a, b, c, d], 7, today).map((s) => s.id)).toEqual(['sub:c', 'sub:a']);
  });

  it('widens with the horizon', () => {
    expect(dueWithin([a, b, c, d], 10, today).map((s) => s.id)).toEqual(['sub:c', 'sub:a', 'sub:b']);
  });
});

describe('duesInMonth', () => {
  it('projects a weekly subscription across the whole month', () => {
    const weekly = sub({ name: 'W', nextDue: '2026-07-03', cycle: 'weekly' });
    expect(duesInMonth([weekly], 2026, 7).map((e) => e.day)).toEqual([3, 10, 17, 24, 31]);
  });

  it('lists a monthly subscription once and ignores other months', () => {
    const monthly = sub({ name: 'M', nextDue: '2026-07-20', cycle: 'monthly' });
    expect(duesInMonth([monthly], 2026, 7).map((e) => e.day)).toEqual([20]);
    expect(duesInMonth([monthly], 2026, 6)).toEqual([]);
    expect(duesInMonth([monthly], 2026, 8).map((e) => e.day)).toEqual([20]);
  });

  it('sorts by day, then name', () => {
    const first = sub({ name: 'B', nextDue: '2026-07-05' });
    const second = sub({ name: 'A', nextDue: '2026-07-05' });
    const third = sub({ name: 'C', nextDue: '2026-07-02' });
    expect(duesInMonth([first, second, third], 2026, 7).map((e) => e.sub.name)).toEqual([
      'C',
      'A',
      'B',
    ]);
  });
});

describe('makeSub / isValidDate / todayIso', () => {
  it('trims the name and omits an empty category', () => {
    const s = makeSub(
      { name: '  Netflix  ', amount: 12.99, cycle: 'monthly', nextDue: '2026-08-01', category: ' ' },
      new Date('2026-07-15T10:00:00Z'),
    );
    expect(s.name).toBe('Netflix');
    expect('category' in s).toBe(false);
    expect(s.id.startsWith('sub:')).toBe(true);
    expect(s.type).toBe('sub');
  });

  it('keeps a real category', () => {
    expect(
      makeSub({ name: 'X', amount: 1, cycle: 'yearly', nextDue: '2026-08-01', category: 'media' })
        .category,
    ).toBe('media');
  });

  it('isValidDate rejects impossible dates', () => {
    expect(isValidDate('2026-07-15')).toBe(true);
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('2026/07/15')).toBe(false);
  });

  it('todayIso renders the LOCAL date', () => {
    expect(todayIso(new Date(2026, 6, 15, 23, 30))).toBe('2026-07-15');
  });
});

describe('addSubParamsSchema', () => {
  const valid = { name: 'Netflix', amount: 12.99, cycle: 'monthly', nextDue: '2026-08-01' };

  it('accepts a valid subscription', () => {
    expect(addSubParamsSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects zero/negative amounts, unknown cycles and bad dates', () => {
    expect(addSubParamsSchema.safeParse({ ...valid, amount: 0 }).success).toBe(false);
    expect(addSubParamsSchema.safeParse({ ...valid, amount: -1 }).success).toBe(false);
    expect(addSubParamsSchema.safeParse({ ...valid, cycle: 'daily' }).success).toBe(false);
    expect(addSubParamsSchema.safeParse({ ...valid, nextDue: '01.08.2026' }).success).toBe(false);
    expect(addSubParamsSchema.safeParse({ ...valid, name: '' }).success).toBe(false);
  });
});

describe('buildSubsContext', () => {
  const today = '2026-07-15';
  const subs = [
    sub({ name: 'Netflix', amount: 12, cycle: 'yearly', nextDue: '2026-07-20' }), // 1/month
    sub({ name: 'Gym', amount: 30, cycle: 'quarterly', nextDue: '2026-08-01' }), // 10/month
    sub({ name: 'Coffee', amount: 5, cycle: 'monthly', nextDue: '2026-07-18' }), // 5/month
  ];

  it('reports the empty state in both languages', () => {
    expect(buildSubsContext([], 'en', today)).toBe('No subscriptions yet.');
    expect(buildSubsContext([], 'de', today)).toBe('Keine Abos angelegt.');
  });

  it('contains the exact monthly total and the next dues in order (en)', () => {
    const text = buildSubsContext(subs, 'en', today, '€');
    expect(text).toContain('3 subscriptions');
    expect(text).toContain('16.00 € per month');
    expect(text.indexOf('Coffee')).toBeLessThan(text.indexOf('Netflix'));
    expect(text.indexOf('Netflix')).toBeLessThan(text.indexOf('Gym'));
    expect(text).toContain('«Coffee» (5.00 € monthly) on 2026-07-18');
  });

  it('uses German wording and number format (de)', () => {
    const text = buildSubsContext(subs, 'de', today, '€');
    expect(text).toContain('3 Abos');
    expect(text).toContain('16,00 € pro Monat');
    expect(text).toContain('Als Nächstes fällig:');
    expect(text).toContain('monatlich');
  });

  it('lists at most three upcoming subscriptions', () => {
    const many = [...subs, sub({ name: 'Extra', nextDue: '2026-09-01' })];
    const text = buildSubsContext(many, 'en', today);
    expect(text).not.toContain('Extra');
  });
});

describe('formatMoney', () => {
  it('always shows cents and follows the UI language', () => {
    expect(formatMoney(16, 'en', '€')).toBe('16.00 €');
    expect(formatMoney(1234.5, 'de', '€')).toBe('1.234,50 €');
    expect(formatMoney(2, 'en', '')).toBe('2.00');
  });
});

describe('cycle exhaustiveness', () => {
  it('monthlyCost covers every declared cycle', () => {
    const cycles: Cycle[] = ['weekly', 'monthly', 'quarterly', 'yearly'];
    for (const cycle of cycles) {
      expect(Number.isFinite(monthlyCost(10, cycle))).toBe(true);
      expect(monthlyCost(10, cycle)).toBeGreaterThan(0);
    }
  });
});
