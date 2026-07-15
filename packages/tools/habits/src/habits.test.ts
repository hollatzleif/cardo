import { describe, expect, it } from 'vitest';
import {
  addDays,
  currentStreak,
  currentWeekDays,
  dateFromKey,
  HEATMAP_DAYS,
  heatLevel,
  heatmapDays,
  localDateKey,
  longestStreak,
} from './habits';

describe('localDateKey', () => {
  it('formats a local date as YYYY-MM-DD with zero padding', () => {
    expect(localDateKey(new Date(2026, 2, 5, 12, 0, 0))).toBe('2026-03-05');
    expect(localDateKey(new Date(2026, 10, 30, 12, 0, 0))).toBe('2026-11-30');
  });

  it('uses the LOCAL day, even when the UTC day differs', () => {
    // Just after local midnight and just before the next one – for any
    // machine not running on UTC, one of these two falls on a different
    // UTC calendar day than the local one.
    const afterMidnight = new Date(2026, 0, 1, 0, 30, 0);
    const beforeMidnight = new Date(2026, 11, 31, 23, 30, 0);

    expect(localDateKey(afterMidnight)).toBe('2026-01-01');
    expect(localDateKey(beforeMidnight)).toBe('2026-12-31');

    if (afterMidnight.getTimezoneOffset() !== 0 || beforeMidnight.getTimezoneOffset() !== 0) {
      const utcKeys = [
        afterMidnight.toISOString().slice(0, 10),
        beforeMidnight.toISOString().slice(0, 10),
      ];
      // At least one UTC day must differ from the local day …
      expect(utcKeys).not.toEqual(['2026-01-01', '2026-12-31']);
      // … and localDateKey must still report the local one for both.
      expect([localDateKey(afterMidnight), localDateKey(beforeMidnight)]).toEqual([
        '2026-01-01',
        '2026-12-31',
      ]);
    }
  });
});

describe('addDays / dateFromKey', () => {
  it('round-trips a key through a local Date', () => {
    expect(localDateKey(dateFromKey('2026-07-04'))).toBe('2026-07-04');
  });

  it('walks across month and year boundaries', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-07-11', -7)).toBe('2026-07-04');
  });
});

describe('currentStreak', () => {
  const today = '2026-07-11';

  it('counts consecutive days including a checked today', () => {
    expect(currentStreak(['2026-07-09', '2026-07-10', today], today)).toBe(3);
  });

  it('still counts the streak up to yesterday when today is unchecked', () => {
    expect(currentStreak(['2026-07-09', '2026-07-10'], today)).toBe(2);
  });

  it('is broken by a gap', () => {
    // 2026-07-08 missing → the run ending 2026-07-07 does not count.
    expect(currentStreak(['2026-07-06', '2026-07-07', '2026-07-10', today], today)).toBe(2);
    // Nothing today or yesterday → 0, no matter what happened before.
    expect(currentStreak(['2026-07-07', '2026-07-08'], today)).toBe(0);
  });

  it('is 0 for an empty history', () => {
    expect(currentStreak([], today)).toBe(0);
  });
});

describe('longestStreak', () => {
  it('finds the longest run across gaps', () => {
    expect(
      longestStreak(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-05', '2026-01-06']),
    ).toBe(3);
  });

  it('handles single days and empty histories', () => {
    expect(longestStreak(['2026-01-01'])).toBe(1);
    expect(longestStreak([])).toBe(0);
  });
});

describe('heatmapDays', () => {
  it('spans exactly 26 weeks = 182 cells ending today', () => {
    const days = heatmapDays('2026-07-11');
    expect(days).toHaveLength(HEATMAP_DAYS);
    expect(days).toHaveLength(182);
    expect(days[days.length - 1]).toBe('2026-07-11');
    expect(days[0]).toBe(addDays('2026-07-11', -181));
  });

  it('starts on the weekday after today (full weeks, column-major)', () => {
    const today = '2026-07-01'; // Wednesday
    const days = heatmapDays(today);
    expect(days[0]).toBe('2026-01-01');
    expect(dateFromKey(days[0] ?? '').getDay()).toBe((dateFromKey(today).getDay() + 1) % 7);
  });

  it('is consecutive (spot check across a month boundary)', () => {
    const days = heatmapDays('2026-07-11');
    const idx = days.indexOf('2026-07-01');
    expect(days[idx - 1]).toBe('2026-06-30');
  });
});

describe('currentWeekDays (week-grid variant)', () => {
  it('returns the Monday–Sunday week containing a midweek day', () => {
    // 2026-07-15 is a Wednesday.
    expect(currentWeekDays('2026-07-15')).toEqual([
      '2026-07-13',
      '2026-07-14',
      '2026-07-15',
      '2026-07-16',
      '2026-07-17',
      '2026-07-18',
      '2026-07-19',
    ]);
  });

  it('starts the week on the day itself for a Monday', () => {
    const week = currentWeekDays('2026-07-13'); // Monday
    expect(week[0]).toBe('2026-07-13');
    expect(week[6]).toBe('2026-07-19');
  });

  it('treats Sunday as the LAST day of the week (Mo–So)', () => {
    const week = currentWeekDays('2026-07-19'); // Sunday
    expect(week[0]).toBe('2026-07-13');
    expect(week[6]).toBe('2026-07-19');
  });

  it('crosses month boundaries', () => {
    const week = currentWeekDays('2026-08-01'); // Saturday
    expect(week[0]).toBe('2026-07-27');
    expect(week[6]).toBe('2026-08-02');
    expect(week).toHaveLength(7);
  });

  it('yields consecutive Monday-first days', () => {
    const week = currentWeekDays('2026-07-15');
    expect(dateFromKey(week[0] ?? '').getDay()).toBe(1); // Monday
    for (let i = 1; i < week.length; i += 1) {
      expect(week[i]).toBe(addDays(week[i - 1] ?? '', 1));
    }
  });
});

describe('heatLevel', () => {
  it('maps ratios to 5 discrete levels', () => {
    expect(heatLevel(0)).toBe(0);
    expect(heatLevel(0.1)).toBe(1);
    expect(heatLevel(0.25)).toBe(1);
    expect(heatLevel(0.4)).toBe(2);
    expect(heatLevel(0.5)).toBe(2);
    expect(heatLevel(0.75)).toBe(3);
    expect(heatLevel(0.76)).toBe(4);
    expect(heatLevel(1)).toBe(4);
  });
});
