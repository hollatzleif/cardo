import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  dayDocId,
  emptyDay,
  formatHours,
  localDateKey,
  rangeKeys,
  sumDays,
} from './stats';

describe('localDateKey', () => {
  it('formats the local calendar day as YYYY-MM-DD with zero padding', () => {
    expect(localDateKey(new Date(2026, 0, 5, 12, 0, 0))).toBe('2026-01-05');
    expect(localDateKey(new Date(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31');
  });

  it('uses local components, so late-evening times stay on the local day', () => {
    // Constructed via local components – identical result in every timezone,
    // whereas toISOString().slice(0, 10) would flip near midnight off UTC.
    expect(localDateKey(new Date(2026, 5, 30, 23, 30, 0))).toBe('2026-06-30');
  });
});

describe('dayDocId / emptyDay', () => {
  it('builds the storage id and duplicates it inside the doc', () => {
    expect(dayDocId('2026-07-11')).toBe('day:2026-07-11');
    expect(emptyDay('2026-07-11')).toEqual({
      id: 'day:2026-07-11',
      date: '2026-07-11',
      tasksCompleted: 0,
      workSeconds: 0,
      pomodoros: 0,
    });
  });
});

describe('rangeKeys', () => {
  const now = new Date(2026, 0, 15, 12, 0, 0);

  it('day = exactly today', () => {
    expect(rangeKeys('day', now)).toEqual(['2026-01-15']);
  });

  it('week = the last 7 days ending today, oldest first', () => {
    const keys = rangeKeys('week', now);
    expect(keys).toHaveLength(7);
    expect(keys[0]).toBe('2026-01-09');
    expect(keys[6]).toBe('2026-01-15');
  });

  it('month = the last 30 days, crossing month and year boundaries', () => {
    const keys = rangeKeys('month', now);
    expect(keys).toHaveLength(30);
    expect(keys[0]).toBe('2025-12-17');
    expect(keys[29]).toBe('2026-01-15');
    expect(new Set(keys).size).toBe(30);
  });

  it('handles leap-day boundaries', () => {
    const keys = rangeKeys('week', new Date(2028, 2, 3, 8, 0, 0)); // 2028-03-03, 2028 is a leap year
    expect(keys[0]).toBe('2028-02-26');
    expect(keys).toContain('2028-02-29');
  });
});

describe('applyEvent', () => {
  const base = emptyDay('2026-01-15');

  it('counts completed tasks', () => {
    const next = applyEvent(base, { type: 'todo:completed' });
    expect(next.tasksCompleted).toBe(1);
    expect(next.workSeconds).toBe(0);
    expect(next.pomodoros).toBe(0);
  });

  it('accumulates work seconds, flooring fractions and clamping negatives', () => {
    let doc = applyEvent(base, { type: 'workclock:session-ended', seconds: 90.9 });
    expect(doc.workSeconds).toBe(90);
    doc = applyEvent(doc, { type: 'workclock:session-ended', seconds: -5 });
    expect(doc.workSeconds).toBe(90);
    doc = applyEvent(doc, { type: 'workclock:session-ended', seconds: Number.NaN });
    expect(doc.workSeconds).toBe(90);
  });

  it('counts only finished WORK pomodoro phases', () => {
    let doc = applyEvent(base, { type: 'pomodoro:finished', phase: 'work' });
    expect(doc.pomodoros).toBe(1);
    doc = applyEvent(doc, { type: 'pomodoro:finished', phase: 'short-break' });
    doc = applyEvent(doc, { type: 'pomodoro:finished', phase: 'long-break' });
    expect(doc.pomodoros).toBe(1);
  });

  it('never mutates the input doc', () => {
    const before = { ...base };
    applyEvent(base, { type: 'todo:completed' });
    expect(base).toEqual(before);
  });
});

describe('sumDays', () => {
  it('sums counters across day docs', () => {
    const a = { ...emptyDay('2026-01-14'), tasksCompleted: 2, workSeconds: 3600, pomodoros: 1 };
    const b = { ...emptyDay('2026-01-15'), tasksCompleted: 1, workSeconds: 1800, pomodoros: 3 };
    expect(sumDays([a, b])).toEqual({ tasksCompleted: 3, workSeconds: 5400, pomodoros: 4 });
    expect(sumDays([])).toEqual({ tasksCompleted: 0, workSeconds: 0, pomodoros: 0 });
  });
});

describe('formatHours', () => {
  it('formats seconds as decimal hours with one decimal, dropping ".0"', () => {
    expect(formatHours(0)).toBe('0 h');
    expect(formatHours(1800)).toBe('0.5 h');
    expect(formatHours(3600)).toBe('1 h');
    expect(formatHours(5400)).toBe('1.5 h');
    expect(formatHours(12600)).toBe('3.5 h');
  });

  it('rounds to the nearest tenth and clamps negatives', () => {
    expect(formatHours(3599)).toBe('1 h'); // 0.9997 h → 1.0
    expect(formatHours(3780)).toBe('1.1 h'); // 1.05 h → 1.1
    expect(formatHours(-42)).toBe('0 h');
  });
});
