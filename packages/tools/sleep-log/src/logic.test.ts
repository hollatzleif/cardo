import { describe, expect, it } from 'vitest';
import {
  addDays,
  averageMinutes,
  buildSleepContext,
  consistencyStdev,
  durationMinutes,
  formatClock,
  formatHm,
  goalDelta,
  goalStreak,
  isValidDate,
  isValidTime,
  lastNights,
  localDayKey,
  logNightParamsSchema,
  makeNight,
  weekSeries,
  type NightDoc,
} from './logic';

const TODAY = '2026-07-15';

function night(date: string, bed: string, wake: string): NightDoc {
  return makeNight(date, bed, wake);
}

describe('durationMinutes', () => {
  it('crosses midnight when the bedtime is later than the wake time', () => {
    expect(durationMinutes('23:30', '07:15')).toBe(465);
    expect(durationMinutes('22:00', '06:00')).toBe(480);
  });

  it('stays on the wake-up day when the bedtime is earlier (night owl)', () => {
    expect(durationMinutes('01:00', '08:00')).toBe(420);
    expect(durationMinutes('00:00', '08:00')).toBe(480);
  });

  it('bed == wake is defined as 0', () => {
    expect(durationMinutes('23:00', '23:00')).toBe(0);
  });

  it('edge times work at both ends of the day', () => {
    expect(durationMinutes('23:59', '00:00')).toBe(1);
    expect(durationMinutes('00:00', '23:59')).toBe(1439);
  });

  it('invalid times yield 0 instead of NaN', () => {
    expect(durationMinutes('25:00', '08:00')).toBe(0);
    expect(durationMinutes('garbage', '08:00')).toBe(0);
  });
});

describe('averageMinutes / consistencyStdev', () => {
  it('averages plainly and is 0 for an empty list', () => {
    expect(averageMinutes([420, 480])).toBe(450);
    expect(averageMinutes([])).toBe(0);
  });

  it('population stdev: single entry and identical entries are 0', () => {
    expect(consistencyStdev([])).toBe(0);
    expect(consistencyStdev([465])).toBe(0);
    expect(consistencyStdev([420, 420, 420])).toBe(0);
  });

  it('population stdev of a known sample', () => {
    // mean 450, deviations ±30 → stdev 30 (population, not sample).
    expect(consistencyStdev([420, 480])).toBe(30);
    expect(consistencyStdev([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2);
  });
});

describe('goalDelta', () => {
  it('is positive over and negative under the goal', () => {
    expect(goalDelta(465, 8)).toBe(-15);
    expect(goalDelta(500, 8)).toBe(20);
    expect(goalDelta(480, 8)).toBe(0);
  });
});

describe('goalStreak', () => {
  const goal = 8 * 60;
  it('counts consecutive goal nights ending today', () => {
    const nights = [
      night('2026-07-13', '22:00', '06:30'), // 510
      night('2026-07-14', '23:00', '07:00'), // 480
      night('2026-07-15', '22:30', '06:30'), // 480
    ];
    expect(goalStreak(nights, goal, TODAY)).toBe(3);
  });

  it('survives an unlogged today and breaks on an under-goal night', () => {
    const nights = [
      night('2026-07-13', '23:00', '07:00'), // 480 ✓
      night('2026-07-14', '01:00', '08:00'), // 420 ✗
    ];
    expect(goalStreak(nights, goal, TODAY)).toBe(0);
    const okYesterday = [night('2026-07-14', '23:00', '07:00')];
    expect(goalStreak(okYesterday, goal, TODAY)).toBe(1);
  });
});

describe('formatHm', () => {
  it('renders hours and minutes, dropping empty parts', () => {
    expect(formatHm(465)).toBe('7 h 45 min');
    expect(formatHm(480)).toBe('8 h');
    expect(formatHm(45)).toBe('45 min');
    expect(formatHm(0)).toBe('0 min');
  });

  it('rounds fractional minutes first', () => {
    expect(formatHm(449.6)).toBe('7 h 30 min');
  });
});

describe('formatClock', () => {
  it('passes 24h through and converts 12h correctly', () => {
    expect(formatClock('23:30', '24')).toBe('23:30');
    expect(formatClock('23:30', '12')).toBe('11:30 PM');
    expect(formatClock('00:15', '12')).toBe('12:15 AM');
    expect(formatClock('12:00', '12')).toBe('12:00 PM');
    expect(formatClock('07:05', '12')).toBe('7:05 AM');
  });
});

describe('validation', () => {
  it('isValidTime accepts HH:MM and rejects everything else', () => {
    expect(isValidTime('00:00')).toBe(true);
    expect(isValidTime('23:59')).toBe(true);
    expect(isValidTime('24:00')).toBe(false);
    expect(isValidTime('7:30')).toBe(false);
    expect(isValidTime('07:60')).toBe(false);
  });

  it('isValidDate rejects impossible dates', () => {
    expect(isValidDate('2026-07-15')).toBe(true);
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('15.07.2026')).toBe(false);
  });

  it('logNightParamsSchema mirrors the time/date rules', () => {
    expect(logNightParamsSchema.safeParse({ bed: '23:30', wake: '07:15' }).success).toBe(true);
    expect(
      logNightParamsSchema.safeParse({ bed: '23:30', wake: '07:15', date: '2026-07-15' }).success,
    ).toBe(true);
    expect(logNightParamsSchema.safeParse({ bed: '25:00', wake: '07:15' }).success).toBe(false);
    expect(
      logNightParamsSchema.safeParse({ bed: '23:30', wake: '07:15', date: 'tomorrow' }).success,
    ).toBe(false);
  });
});

describe('dates', () => {
  it('localDayKey renders the LOCAL date (00:30 stays today – no UTC drift)', () => {
    expect(localDayKey(new Date(2026, 6, 15, 0, 30))).toBe('2026-07-15');
  });

  it('addDays crosses boundaries', () => {
    expect(addDays('2026-08-01', -1)).toBe('2026-07-31');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
  });
});

describe('lastNights / weekSeries', () => {
  const nights = [
    night('2026-07-10', '23:00', '07:00'),
    night('2026-07-15', '23:30', '07:15'),
    night('2026-07-13', '01:00', '08:00'),
  ];

  it('lastNights sorts newest first and limits', () => {
    expect(lastNights(nights, 2).map((n) => n.date)).toEqual(['2026-07-15', '2026-07-13']);
  });

  it('weekSeries covers exactly 7 days ending today, gaps as null', () => {
    const series = weekSeries(nights, TODAY);
    expect(series).toHaveLength(7);
    expect(series[0]).toEqual({ date: '2026-07-09', minutes: null });
    expect(series[4]).toEqual({ date: '2026-07-13', minutes: 420 });
    expect(series[6]).toEqual({ date: '2026-07-15', minutes: 465 });
  });
});

describe('makeNight', () => {
  it('keys the doc by wake-up date', () => {
    const doc = makeNight('2026-07-15', '23:30', '07:15');
    expect(doc.id).toBe('night:2026-07-15');
    expect(doc.type).toBe('night');
  });
});

describe('buildSleepContext', () => {
  it('reports the empty state in both languages', () => {
    expect(buildSleepContext([], 'en', TODAY, 8)).toBe('No nights logged yet.');
    expect(buildSleepContext([], 'de', TODAY, 8)).toBe('Noch keine Nächte erfasst.');
  });

  it('mentions last night, average and goal streak (en)', () => {
    const nights = [
      night('2026-07-14', '23:00', '07:00'), // 480
      night('2026-07-15', '23:30', '07:15'), // 465
    ];
    const text = buildSleepContext(nights, 'en', TODAY, 8);
    expect(text).toContain('Last night (2026-07-15): 23:30–07:15, 7 h 45 min.');
    expect(text).toContain('7-day average: 7 h 53 min.'); // (480+465)/2 = 472.5 → 473
    expect(text).toContain('Goal 8 h');
  });

  it('uses German wording (de)', () => {
    const nights = [night('2026-07-15', '23:00', '07:00')];
    const text = buildSleepContext(nights, 'de', TODAY, 8);
    expect(text).toContain('Letzte Nacht (2026-07-15)');
    expect(text).toContain('7-Tage-Schnitt: 8 h.');
    expect(text).toContain('Serie: 1 Nacht/Nächte.');
  });
});
