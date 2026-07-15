import { describe, expect, it } from 'vitest';
import {
  addDays,
  averageMood,
  buildMoodContext,
  localDayKey,
  logMoodParamsSchema,
  makeDayDoc,
  monthMatrix,
  moodEmoji,
  moodSeries,
  moodToken,
  streak,
  type MoodDayDoc,
} from './logic';

const TODAY = '2026-07-15';

function entry(date: string, mood = 3, note?: string): MoodDayDoc {
  return makeDayDoc(date, mood, note);
}

describe('localDayKey / addDays', () => {
  it('renders the LOCAL date (00:30 stays today – no UTC drift)', () => {
    expect(localDayKey(new Date(2026, 6, 15, 0, 30))).toBe('2026-07-15');
    expect(localDayKey(new Date(2026, 0, 1, 23, 59))).toBe('2026-01-01');
  });

  it('addDays crosses month/year boundaries in both directions', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29'); // leap year
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('makeDayDoc', () => {
  it('keys the doc by date and trims the note', () => {
    const doc = makeDayDoc('2026-07-15', 4, '  good day  ');
    expect(doc.id).toBe('day:2026-07-15');
    expect(doc.type).toBe('day');
    expect(doc.mood).toBe(4);
    expect(doc.note).toBe('good day');
  });

  it('omits an empty note entirely', () => {
    expect('note' in makeDayDoc('2026-07-15', 2, '   ')).toBe(false);
    expect('note' in makeDayDoc('2026-07-15', 2)).toBe(false);
  });
});

describe('streak', () => {
  it('counts consecutive days ending today', () => {
    const entries = [entry('2026-07-13'), entry('2026-07-14'), entry('2026-07-15')];
    expect(streak(entries, TODAY)).toBe(3);
  });

  it('survives an unlogged today by ending at yesterday', () => {
    const entries = [entry('2026-07-13'), entry('2026-07-14')];
    expect(streak(entries, TODAY)).toBe(2);
  });

  it('breaks on a gap', () => {
    const entries = [entry('2026-07-12'), entry('2026-07-14'), entry('2026-07-15')];
    expect(streak(entries, TODAY)).toBe(2);
  });

  it('is 0 when neither today nor yesterday is logged', () => {
    expect(streak([entry('2026-07-10')], TODAY)).toBe(0);
    expect(streak([], TODAY)).toBe(0);
  });

  it('counts across a month boundary', () => {
    const entries = [entry('2026-06-30'), entry('2026-07-01')];
    expect(streak(entries, '2026-07-01')).toBe(2);
  });
});

describe('averageMood', () => {
  it('averages only entries inside the window', () => {
    const entries = [
      entry('2026-07-15', 5),
      entry('2026-07-14', 3),
      entry('2026-07-08', 1), // outside a 7-day window ending 07-15 (starts 07-09)
    ];
    expect(averageMood(entries, 7, TODAY)).toBe(4);
  });

  it('includes the window edge (today − days + 1)', () => {
    expect(averageMood([entry('2026-07-09', 2)], 7, TODAY)).toBe(2);
  });

  it('ignores future entries and returns null for an empty window', () => {
    expect(averageMood([entry('2026-07-20', 5)], 7, TODAY)).toBeNull();
    expect(averageMood([], 7, TODAY)).toBeNull();
  });
});

describe('moodSeries', () => {
  it('is chronological, gap-filled with null and ends at today', () => {
    const entries = [entry('2026-07-15', 4), entry('2026-07-13', 2)];
    expect(moodSeries(entries, 3, TODAY)).toEqual([
      { date: '2026-07-13', mood: 2 },
      { date: '2026-07-14', mood: null },
      { date: '2026-07-15', mood: 4 },
    ]);
  });
});

describe('monthMatrix', () => {
  it('February in a leap year, week starting Monday', () => {
    const weeks = monthMatrix(2024, 2, 'mon');
    // 2024-02-01 is a Thursday → 3 leading nulls; 29 days → 5 weeks.
    expect(weeks).toHaveLength(5);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks[0]).toEqual([null, null, null, '2024-02-01', '2024-02-02', '2024-02-03', '2024-02-04']);
    expect(weeks[4]?.[3]).toBe('2024-02-29');
    expect(weeks[4]?.slice(4)).toEqual([null, null, null]);
  });

  it('February in a leap year, week starting Sunday', () => {
    const weeks = monthMatrix(2024, 2, 'sun');
    // Sunday-start: Thursday = index 4 → 4 leading nulls.
    expect(weeks[0]).toEqual([null, null, null, null, '2024-02-01', '2024-02-02', '2024-02-03']);
    expect(weeks).toHaveLength(5);
  });

  it('non-leap February with 28 days', () => {
    const weeks = monthMatrix(2026, 2, 'mon');
    const days = weeks.flat().filter((c): c is string => c !== null);
    expect(days).toHaveLength(28);
    expect(days[0]).toBe('2026-02-01');
    expect(days[27]).toBe('2026-02-28');
  });

  it('a month starting exactly on the week start has no leading padding', () => {
    // 2026-06-01 is a Monday.
    const weeks = monthMatrix(2026, 6, 'mon');
    expect(weeks[0]?.[0]).toBe('2026-06-01');
  });
});

describe('moodToken / moodEmoji', () => {
  it('maps mood 1-5 onto the chart tokens', () => {
    expect(moodToken(1)).toBe('var(--chart-1)');
    expect(moodToken(3)).toBe('var(--chart-3)');
    expect(moodToken(5)).toBe('var(--chart-5)');
  });

  it('clamps out-of-range moods instead of emitting broken CSS', () => {
    expect(moodToken(0)).toBe('var(--chart-1)');
    expect(moodToken(9)).toBe('var(--chart-5)');
  });

  it('emoji scale runs from bad to great', () => {
    expect(moodEmoji(1)).toBe('😞');
    expect(moodEmoji(3)).toBe('😐');
    expect(moodEmoji(5)).toBe('😄');
    expect(moodEmoji(99)).toBe('😄'); // clamped
  });
});

describe('logMoodParamsSchema', () => {
  it('accepts 1-5 integers with an optional note', () => {
    expect(logMoodParamsSchema.safeParse({ mood: 3 }).success).toBe(true);
    expect(logMoodParamsSchema.safeParse({ mood: 5, note: 'yay' }).success).toBe(true);
  });

  it('rejects out-of-range and fractional moods', () => {
    expect(logMoodParamsSchema.safeParse({ mood: 0 }).success).toBe(false);
    expect(logMoodParamsSchema.safeParse({ mood: 6 }).success).toBe(false);
    expect(logMoodParamsSchema.safeParse({ mood: 3.5 }).success).toBe(false);
    expect(logMoodParamsSchema.safeParse({}).success).toBe(false);
  });
});

describe('buildMoodContext', () => {
  it('reports the empty state in both languages', () => {
    expect(buildMoodContext([], 'en', TODAY)).toBe('No mood entries yet.');
    expect(buildMoodContext([], 'de', TODAY)).toBe('Noch keine Stimmung eingetragen.');
  });

  it('mentions today, streak and 7-day average (en)', () => {
    const entries = [entry('2026-07-14', 3), entry('2026-07-15', 5, 'sunny')];
    const text = buildMoodContext(entries, 'en', TODAY);
    expect(text).toContain("Today's mood: 5/5");
    expect(text).toContain('"sunny"');
    expect(text).toContain('Streak: 2 day(s).');
    expect(text).toContain('7-day average: 4.0/5.');
  });

  it('handles an unlogged today (de)', () => {
    const entries = [entry('2026-07-14', 2)];
    const text = buildMoodContext(entries, 'de', TODAY);
    expect(text).toContain('Heute ist noch keine Stimmung eingetragen.');
    expect(text).toContain('Serie: 1 Tag(e).');
    expect(text).toContain('7-Tage-Schnitt: 2.0/5.');
  });
});
