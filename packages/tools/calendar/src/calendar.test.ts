import { describe, expect, it } from 'vitest';
import {
  addMonths,
  dateKey,
  eventStart,
  monthGrid,
  reminderFireTime,
  weekdayLabels,
} from './calendar';

describe('monthGrid', () => {
  it('is always 6 rows of 7 days', () => {
    const grid = monthGrid(2026, 5); // June 2026
    expect(grid).toHaveLength(6);
    for (const week of grid) expect(week).toHaveLength(7);
  });

  it('aligns the first cell for a known month (February 2026, week starts Monday)', () => {
    // 2026-02-01 is a Sunday → the Monday-based grid starts on 2026-01-26.
    const grid = monthGrid(2026, 1, 1);
    expect(dateKey(grid[0]![0]!)).toBe('2026-01-26');
    expect(grid[0]![0]!.getDay()).toBe(1); // Monday
    expect(dateKey(grid[0]![6]!)).toBe('2026-02-01');
    expect(dateKey(grid[5]![6]!)).toBe('2026-03-08');
  });

  it('starts on the 1st when the month begins on the week start', () => {
    // 2026-06-01 is a Monday.
    const grid = monthGrid(2026, 5, 1);
    expect(dateKey(grid[0]![0]!)).toBe('2026-06-01');
  });

  it('respects weekStartsOn = 0 (Sunday)', () => {
    const grid = monthGrid(2026, 1, 0);
    expect(grid[0]![0]!.getDay()).toBe(0);
    expect(dateKey(grid[0]![0]!)).toBe('2026-02-01');
  });

  it('every column keeps a constant weekday', () => {
    const grid = monthGrid(2026, 6, 1);
    for (const week of grid) {
      for (let col = 0; col < 7; col++) {
        expect(week[col]!.getDay()).toBe((1 + col) % 7);
      }
    }
  });

  it('contains every day of the month exactly once', () => {
    const keys = monthGrid(2026, 1)
      .flat()
      .map(dateKey)
      .filter((k) => k.startsWith('2026-02'));
    expect(new Set(keys).size).toBe(28);
  });
});

describe('dateKey / eventStart (LOCAL time)', () => {
  it('produces local-time keys', () => {
    expect(dateKey(new Date(2026, 5, 3, 0, 30))).toBe('2026-06-03');
    expect(dateKey(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31');
  });

  it('round-trips through eventStart without timezone drift', () => {
    // Would break if "YYYY-MM-DD" were parsed as UTC in a non-UTC zone.
    expect(dateKey(eventStart('2026-06-03', '00:30'))).toBe('2026-06-03');
    const start = eventStart('2026-06-03', '09:15');
    expect(start.getHours()).toBe(9);
    expect(start.getMinutes()).toBe(15);
  });
});

describe('reminderFireTime', () => {
  it('subtracts the reminder minutes from the local event start', () => {
    const fire = reminderFireTime('2030-01-01', '12:00', 10);
    expect(dateKey(fire)).toBe('2030-01-01');
    expect(fire.getHours()).toBe(11);
    expect(fire.getMinutes()).toBe(50);
  });

  it('crosses midnight backwards when needed', () => {
    const fire = reminderFireTime('2030-01-01', '00:05', 30);
    expect(dateKey(fire)).toBe('2029-12-31');
    expect(fire.getHours()).toBe(23);
    expect(fire.getMinutes()).toBe(35);
  });
});

describe('addMonths', () => {
  it('moves within a year', () => {
    expect(addMonths(2026, 3, 2)).toEqual({ year: 2026, month: 5 });
  });

  it('rolls over year boundaries in both directions', () => {
    expect(addMonths(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    expect(addMonths(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
  });
});

describe('weekdayLabels', () => {
  it('returns 7 labels starting at the requested weekday', () => {
    const labels = weekdayLabels('en', 1);
    expect(labels).toHaveLength(7);
    const monday = new Intl.DateTimeFormat('en', { weekday: 'short' }).format(new Date(2024, 0, 8));
    const sunday = new Intl.DateTimeFormat('en', { weekday: 'short' }).format(new Date(2024, 0, 7));
    expect(labels[0]).toBe(monday);
    expect(labels[6]).toBe(sunday);
  });
});
