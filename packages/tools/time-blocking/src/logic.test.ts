import { describe, expect, it } from 'vitest';
import {
  addBlockParamsSchema,
  blockMinutes,
  buildTimeBlockingContext,
  findConflicts,
  formatTime,
  isValidDateKey,
  isValidHhmm,
  makeBlock,
  overlaps,
  shiftDayKey,
  snapToGrid,
  sortBlocks,
  toHhmm,
  toMinutes,
  todayKey,
  type Block,
  type DayDoc,
} from './logic';

function block(partial: Partial<Block>): Block {
  return {
    id: `block:${partial.title ?? 'test'}`,
    start: '09:00',
    end: '10:00',
    title: 'Test block',
    ...partial,
  };
}

describe('isValidHhmm', () => {
  it('accepts 00:00 through 23:59', () => {
    expect(isValidHhmm('00:00')).toBe(true);
    expect(isValidHhmm('09:30')).toBe(true);
    expect(isValidHhmm('23:59')).toBe(true);
  });

  it('rejects out-of-range and malformed values', () => {
    expect(isValidHhmm('24:00')).toBe(false);
    expect(isValidHhmm('12:60')).toBe(false);
    expect(isValidHhmm('9:30')).toBe(false);
    expect(isValidHhmm('0930')).toBe(false);
    expect(isValidHhmm('')).toBe(false);
  });
});

describe('toMinutes / toHhmm', () => {
  it('round-trips valid times', () => {
    expect(toMinutes('00:00')).toBe(0);
    expect(toMinutes('09:30')).toBe(570);
    expect(toMinutes('23:59')).toBe(1439);
    expect(toHhmm(570)).toBe('09:30');
    expect(toHhmm(0)).toBe('00:00');
  });

  it('clamps out-of-range minutes into the day', () => {
    expect(toHhmm(-5)).toBe('00:00');
    expect(toHhmm(1440)).toBe('23:59');
  });
});

describe('snapToGrid', () => {
  it('rounds to the nearest 15-minute slot', () => {
    expect(snapToGrid('09:07', 15)).toBe('09:00');
    expect(snapToGrid('09:08', 15)).toBe('09:15');
    expect(snapToGrid('09:00', 15)).toBe('09:00');
  });

  it('supports 30 and 60 minute grids', () => {
    expect(snapToGrid('09:14', 30)).toBe('09:00');
    expect(snapToGrid('09:16', 30)).toBe('09:30');
    expect(snapToGrid('09:29', 60)).toBe('09:00');
    expect(snapToGrid('09:31', 60)).toBe('10:00');
  });

  it('clamps down at the end of the day instead of producing 24:00', () => {
    expect(snapToGrid('23:59', 60)).toBe('23:00');
    expect(snapToGrid('23:59', 30)).toBe('23:30');
    expect(snapToGrid('23:55', 15)).toBe('23:45');
  });

  it('returns invalid input unchanged', () => {
    expect(snapToGrid('nope', 15)).toBe('nope');
    expect(snapToGrid('09:00', 0)).toBe('09:00');
  });
});

describe('blockMinutes', () => {
  it('measures the duration in minutes', () => {
    expect(blockMinutes({ start: '09:00', end: '10:30' })).toBe(90);
    expect(blockMinutes({ start: '00:00', end: '23:59' })).toBe(1439);
  });

  it('is 0 (never negative) when end is at or before start', () => {
    expect(blockMinutes({ start: '10:00', end: '10:00' })).toBe(0);
    expect(blockMinutes({ start: '10:00', end: '09:00' })).toBe(0);
  });
});

describe('overlaps', () => {
  it('detects overlapping ranges', () => {
    expect(overlaps({ start: '09:00', end: '10:00' }, { start: '09:30', end: '10:30' })).toBe(true);
    expect(overlaps({ start: '09:30', end: '10:30' }, { start: '09:00', end: '10:00' })).toBe(true);
    expect(overlaps({ start: '09:00', end: '12:00' }, { start: '10:00', end: '11:00' })).toBe(true);
  });

  it('treats touching edges as NOT overlapping', () => {
    expect(overlaps({ start: '09:00', end: '10:00' }, { start: '10:00', end: '11:00' })).toBe(false);
  });

  it('ignores zero-length and inverted blocks', () => {
    expect(overlaps({ start: '09:00', end: '09:00' }, { start: '08:00', end: '10:00' })).toBe(false);
    expect(overlaps({ start: '10:00', end: '09:00' }, { start: '08:00', end: '12:00' })).toBe(false);
  });
});

describe('findConflicts', () => {
  it('flags every block that overlaps another one', () => {
    const a = block({ id: 'block:a', start: '09:00', end: '10:00' });
    const b = block({ id: 'block:b', start: '09:30', end: '10:30' });
    const c = block({ id: 'block:c', start: '11:00', end: '12:00' });
    const conflicts = findConflicts([a, b, c]);
    expect(conflicts.has('block:a')).toBe(true);
    expect(conflicts.has('block:b')).toBe(true);
    expect(conflicts.has('block:c')).toBe(false);
  });

  it('is empty for a conflict-free or empty day', () => {
    expect(findConflicts([]).size).toBe(0);
    const a = block({ id: 'block:a', start: '09:00', end: '10:00' });
    const b = block({ id: 'block:b', start: '10:00', end: '11:00' });
    expect(findConflicts([a, b]).size).toBe(0);
  });
});

describe('sortBlocks', () => {
  it('sorts by start, then end, then title, without mutating', () => {
    const late = block({ id: 'block:late', start: '14:00', end: '15:00', title: 'Late' });
    const shortB = block({ id: 'block:b', start: '09:00', end: '09:30', title: 'B' });
    const longA = block({ id: 'block:a', start: '09:00', end: '10:00', title: 'A' });
    const twinC = block({ id: 'block:c', start: '09:00', end: '09:30', title: 'A twin' });
    const input = [late, shortB, longA, twinC];
    const sorted = sortBlocks(input);
    expect(sorted.map((b) => b.id)).toEqual(['block:c', 'block:b', 'block:a', 'block:late']);
    expect(input[0]?.id).toBe('block:late'); // untouched
  });
});

describe('todayKey', () => {
  it('uses the LOCAL date – 00:30 local stays on the same day (no UTC drift)', () => {
    // In any timezone east of UTC, toISOString() at 00:30 local would yield
    // the PREVIOUS day; todayKey must not.
    const halfPastMidnight = new Date(2026, 6, 15, 0, 30, 0);
    expect(todayKey(halfPastMidnight)).toBe('2026-07-15');
  });

  it('pads month and day', () => {
    expect(todayKey(new Date(2026, 0, 5, 23, 59, 0))).toBe('2026-01-05');
  });
});

describe('shiftDayKey', () => {
  it('shifts across month and year boundaries', () => {
    expect(shiftDayKey('2026-07-15', 1)).toBe('2026-07-16');
    expect(shiftDayKey('2026-07-31', 1)).toBe('2026-08-01');
    expect(shiftDayKey('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDayKey('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('returns invalid keys unchanged', () => {
    expect(shiftDayKey('nope', 1)).toBe('nope');
  });
});

describe('isValidDateKey', () => {
  it('accepts real dates and rejects impossible ones', () => {
    expect(isValidDateKey('2026-07-15')).toBe(true);
    expect(isValidDateKey('2026-02-29')).toBe(false); // 2026 is no leap year
    expect(isValidDateKey('2026-13-01')).toBe(false);
    expect(isValidDateKey('15.07.2026')).toBe(false);
  });
});

describe('makeBlock', () => {
  it('trims the title and drops an empty category', () => {
    const b = makeBlock({ start: '09:00', end: '10:00', title: '  Deep work  ', category: ' ' });
    expect(b.title).toBe('Deep work');
    expect(b.category).toBeUndefined();
    expect(b.id.startsWith('block:')).toBe(true);
  });

  it('keeps a real category', () => {
    const b = makeBlock({ start: '09:00', end: '10:00', title: 'Call', category: ' work ' });
    expect(b.category).toBe('work');
  });
});

describe('formatTime', () => {
  it('passes 24h format through', () => {
    expect(formatTime('09:05', false)).toBe('09:05');
    expect(formatTime('13:30', false)).toBe('13:30');
  });

  it('renders 12h with AM/PM including the edge hours', () => {
    expect(formatTime('00:15', true)).toBe('12:15 AM');
    expect(formatTime('09:05', true)).toBe('9:05 AM');
    expect(formatTime('12:00', true)).toBe('12:00 PM');
    expect(formatTime('13:30', true)).toBe('1:30 PM');
    expect(formatTime('23:59', true)).toBe('11:59 PM');
  });
});

describe('addBlockParamsSchema', () => {
  it('accepts a valid payload with optional date and category', () => {
    expect(
      addBlockParamsSchema.safeParse({ start: '09:00', end: '10:00', title: 'Focus' }).success,
    ).toBe(true);
    expect(
      addBlockParamsSchema.safeParse({
        date: '2026-07-15',
        start: '09:00',
        end: '10:00',
        title: 'Focus',
        category: 'work',
      }).success,
    ).toBe(true);
  });

  it('rejects malformed times, dates and empty titles', () => {
    expect(addBlockParamsSchema.safeParse({ start: '9:00', end: '10:00', title: 'x' }).success).toBe(false);
    expect(addBlockParamsSchema.safeParse({ start: '09:00', end: '24:00', title: 'x' }).success).toBe(false);
    expect(
      addBlockParamsSchema.safeParse({ date: '15.07.2026', start: '09:00', end: '10:00', title: 'x' }).success,
    ).toBe(false);
    expect(addBlockParamsSchema.safeParse({ start: '09:00', end: '10:00', title: '' }).success).toBe(false);
  });
});

describe('buildTimeBlockingContext', () => {
  const day = (blocks: Block[]): DayDoc => ({ type: 'day', date: '2026-07-15', blocks });

  it('reports an empty day in both languages', () => {
    expect(buildTimeBlockingContext(null, 'en', '2026-07-15')).toBe(
      'No time blocks planned for today (2026-07-15).',
    );
    expect(buildTimeBlockingContext(day([]), 'de', '2026-07-15')).toBe(
      'Für heute (2026-07-15) sind keine Zeitblöcke geplant.',
    );
  });

  it('lists blocks sorted with total minutes and category', () => {
    const text = buildTimeBlockingContext(
      day([
        block({ id: 'block:b', start: '11:00', end: '12:00', title: 'Lunch' }),
        block({ id: 'block:a', start: '09:00', end: '10:30', title: 'Deep work', category: 'focus' }),
      ]),
      'en',
      '2026-07-15',
    );
    expect(text).toContain('2 time blocks today (2026-07-15), 150 minutes planned');
    expect(text.indexOf('Deep work')).toBeLessThan(text.indexOf('Lunch'));
    expect(text).toContain('09:00–10:30 «Deep work» (focus)');
    expect(text).not.toContain('overlapping');
  });

  it('calls out conflicts', () => {
    const text = buildTimeBlockingContext(
      day([
        block({ id: 'block:a', start: '09:00', end: '10:00', title: 'A' }),
        block({ id: 'block:b', start: '09:30', end: '10:30', title: 'B' }),
      ]),
      'de',
      '2026-07-15',
    );
    expect(text).toContain('Überschneidungen: «A», «B».');
  });
});
