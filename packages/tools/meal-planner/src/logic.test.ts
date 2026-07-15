import { describe, expect, it } from 'vitest';
import {
  addDaysLocal,
  aggregateIngredients,
  buildMealContext,
  formatIngredient,
  formatIngredients,
  localDateKey,
  normalizeName,
  parseIngredients,
  slotKey,
  weekDates,
  type Ingredient,
  type SlotDoc,
} from './logic';

function slot(partial: Partial<SlotDoc>): SlotDoc {
  return {
    id: 'slot:2026-07-13:lunch',
    type: 'slot',
    date: '2026-07-13',
    slot: 'lunch',
    meal: 'Pasta',
    ingredients: [],
    ...partial,
  };
}

const ings = (list: Ingredient[]) => [{ ingredients: list }];

describe('slotKey', () => {
  it('builds the storage id from date and slot', () => {
    expect(slotKey('2026-07-13', 'breakfast')).toBe('slot:2026-07-13:breakfast');
    expect(slotKey('2026-01-01', 'snack')).toBe('slot:2026-01-01:snack');
  });
});

describe('localDateKey / addDaysLocal', () => {
  it('formats a local date with zero padding', () => {
    expect(localDateKey(new Date(2026, 0, 5, 23, 59, 0))).toBe('2026-01-05');
  });

  it('adds days across month and year boundaries', () => {
    expect(addDaysLocal('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDaysLocal('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysLocal('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('handles leap years', () => {
    expect(addDaysLocal('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('weekDates', () => {
  it('returns the Monday-based week containing a Wednesday', () => {
    // 2026-07-15 is a Wednesday.
    const dates = weekDates(new Date(2026, 6, 15, 10, 0, 0), true);
    expect(dates).toHaveLength(7);
    expect(dates[0]).toBe('2026-07-13'); // Monday
    expect(dates[6]).toBe('2026-07-19'); // Sunday
  });

  it('returns the Sunday-based week when weekStartsMonday is false', () => {
    const dates = weekDates(new Date(2026, 6, 15, 10, 0, 0), false);
    expect(dates[0]).toBe('2026-07-12'); // Sunday
    expect(dates[6]).toBe('2026-07-18'); // Saturday
  });

  it('keeps a Monday itself as the first day', () => {
    const dates = weekDates(new Date(2026, 6, 13, 0, 30, 0), true);
    expect(dates[0]).toBe('2026-07-13');
  });

  it('handles a Sunday with Monday start (Sunday is the LAST day)', () => {
    const dates = weekDates(new Date(2026, 6, 19, 12, 0, 0), true);
    expect(dates[0]).toBe('2026-07-13');
    expect(dates[6]).toBe('2026-07-19');
  });
});

describe('normalizeName', () => {
  it('trims and lowercases', () => {
    expect(normalizeName('  Milch ')).toBe('milch');
    expect(normalizeName('MILCH')).toBe('milch');
  });
});

describe('aggregateIngredients', () => {
  it('sums quantities when name and unit match (200 g + 300 g = 500 g)', () => {
    const lines = aggregateIngredients(
      ings([
        { name: 'Mehl', qty: 200, unit: 'g' },
        { name: 'Mehl', qty: 300, unit: 'g' },
      ]),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ name: 'Mehl', qty: 500, unit: 'g' });
  });

  it('dedupes case-insensitively and trimmed ("Milch" vs " milch ")', () => {
    const lines = aggregateIngredients(
      ings([
        { name: 'Milch', qty: 1, unit: 'l' },
        { name: ' milch ', qty: 2, unit: 'l' },
      ]),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ name: 'Milch', qty: 3, unit: 'l' });
  });

  it('keeps different units of the same ingredient separate (1 l vs 200 ml)', () => {
    const lines = aggregateIngredients(
      ings([
        { name: 'Milch', qty: 1, unit: 'l' },
        { name: 'Milch', qty: 200, unit: 'ml' },
      ]),
    );
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.unit === 'l')?.qty).toBe(1);
    expect(lines.find((l) => l.unit === 'ml')?.qty).toBe(200);
  });

  it('merges unit-less entries and entries without qty', () => {
    const lines = aggregateIngredients(
      ings([{ name: 'Salz' }, { name: 'salz' }, { name: 'Eier', qty: 2 }, { name: 'Eier', qty: 4 }]),
    );
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.name === 'Salz')?.qty).toBeUndefined();
    expect(lines.find((l) => l.name === 'Eier')?.qty).toBe(6);
  });

  it('aggregates across multiple slots and skips empty names', () => {
    const lines = aggregateIngredients([
      { ingredients: [{ name: 'Reis', qty: 100, unit: 'g' }, { name: '  ' }] },
      { ingredients: [{ name: 'reis', qty: 150, unit: 'g' }] },
      { ingredients: [] },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ name: 'Reis', qty: 250, unit: 'g' });
  });

  it('returns lines sorted by name for a stable list', () => {
    const lines = aggregateIngredients(
      ings([{ name: 'Zucker' }, { name: 'Apfel' }, { name: 'Mehl' }]),
    );
    expect(lines.map((l) => l.name)).toEqual(['Apfel', 'Mehl', 'Zucker']);
  });

  it('empty input yields an empty list', () => {
    expect(aggregateIngredients([])).toEqual([]);
    expect(aggregateIngredients(ings([]))).toEqual([]);
  });
});

describe('parseIngredients', () => {
  it('parses "<qty> <unit> <name>"', () => {
    expect(parseIngredients('200 g Mehl')).toEqual([{ name: 'Mehl', qty: 200, unit: 'g' }]);
  });

  it('parses "<qty> <name>" without a unit', () => {
    expect(parseIngredients('2 Eier')).toEqual([{ name: 'Eier', qty: 2 }]);
  });

  it('parses plain names', () => {
    expect(parseIngredients('Salz')).toEqual([{ name: 'Salz' }]);
  });

  it('splits on commas and newlines and skips empty parts', () => {
    expect(parseIngredients('200 g Mehl, 2 Eier\nSalz, ')).toEqual([
      { name: 'Mehl', qty: 200, unit: 'g' },
      { name: 'Eier', qty: 2 },
      { name: 'Salz' },
    ]);
  });

  it('accepts decimal quantities with comma or dot', () => {
    expect(parseIngredients('1,5 l Milch')).toEqual([{ name: 'Milch', qty: 1.5, unit: 'l' }]);
    expect(parseIngredients('0.5 kg Reis')).toEqual([{ name: 'Reis', qty: 0.5, unit: 'kg' }]);
  });

  it('empty text yields an empty list', () => {
    expect(parseIngredients('')).toEqual([]);
    expect(parseIngredients('  ,  ')).toEqual([]);
  });
});

describe('formatIngredient(s)', () => {
  it('roundtrips through parseIngredients', () => {
    const original = '200 g Mehl, 2 Eier, Salz';
    expect(formatIngredients(parseIngredients(original))).toBe(original);
  });

  it('formats decimals with a comma (de-style input)', () => {
    expect(formatIngredient({ name: 'Milch', qty: 1.5, unit: 'l' })).toBe('1,5 l Milch');
  });
});

describe('buildMealContext', () => {
  const slots = [
    slot({ date: '2026-07-13', slot: 'breakfast', meal: 'Müsli' }),
    slot({ date: '2026-07-13', slot: 'dinner', meal: 'Pizza' }),
    slot({ date: '2026-07-14', slot: 'lunch', meal: 'Salat' }),
    slot({ date: '2026-07-20', slot: 'lunch', meal: 'not shown' }),
  ];

  it('summarizes today and tomorrow in English', () => {
    const text = buildMealContext(slots, '2026-07-13', 'en');
    expect(text).toContain('Today (2026-07-13): breakfast: Müsli, dinner: Pizza.');
    expect(text).toContain('Tomorrow (2026-07-14): lunch: Salat.');
    expect(text).not.toContain('not shown');
  });

  it('summarizes in German with German slot labels', () => {
    const text = buildMealContext(slots, '2026-07-13', 'de');
    expect(text).toContain('Heute (2026-07-13): Frühstück: Müsli, Abend: Pizza.');
    expect(text).toContain('Morgen (2026-07-14): Mittag: Salat.');
  });

  it('says "nothing planned" for empty days', () => {
    expect(buildMealContext([], '2026-07-13', 'en')).toBe(
      'Today (2026-07-13): nothing planned. Tomorrow (2026-07-14): nothing planned.',
    );
    expect(buildMealContext([], '2026-07-13', 'de')).toContain('nichts geplant');
  });

  it('ignores slots whose meal is only whitespace', () => {
    const text = buildMealContext(
      [slot({ date: '2026-07-13', slot: 'lunch', meal: '   ' })],
      '2026-07-13',
      'en',
    );
    expect(text).toContain('nothing planned');
  });
});
