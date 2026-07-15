import { describe, expect, it } from 'vitest';
import {
  addDays,
  buildWorkoutContext,
  formatWeight,
  isValidDate,
  isoWeekStart,
  kgToLb,
  localDayKey,
  logSessionParamsSchema,
  makeSession,
  personalRecords,
  sessionVolume,
  sessionsThisWeek,
  volumeByWeekday,
  weeklyVolume,
  type Exercise,
  type SessionDoc,
} from './logic';

// 2026-07-15 is a Wednesday; its ISO week runs 2026-07-13 (Mon) … 2026-07-19 (Sun).
const TODAY = '2026-07-15';

function session(date: string, exercises: Exercise[], kind = 'Push'): SessionDoc {
  return {
    id: `session:${date}-${kind}`,
    type: 'session',
    date,
    kind,
    exercises,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('sessionVolume', () => {
  it('sums sets × reps × weight', () => {
    const s = session(TODAY, [
      { name: 'Squat', sets: 3, reps: 5, weightKg: 100 }, // 1500
      { name: 'Bench', sets: 3, reps: 8, weightKg: 60 }, // 1440
    ]);
    expect(sessionVolume(s)).toBe(2940);
  });

  it('bodyweight exercises (no weight or 0) count sets × reps', () => {
    const s = session(TODAY, [
      { name: 'Pull-up', sets: 4, reps: 10 }, // 40
      { name: 'Push-up', sets: 2, reps: 20, weightKg: 0 }, // 40
    ]);
    expect(sessionVolume(s)).toBe(80);
  });

  it('is 0 for an empty session', () => {
    expect(sessionVolume(session(TODAY, []))).toBe(0);
  });
});

describe('isoWeekStart / weekly windows', () => {
  it('finds Monday for every day of the week', () => {
    expect(isoWeekStart('2026-07-13')).toBe('2026-07-13'); // Monday itself
    expect(isoWeekStart('2026-07-15')).toBe('2026-07-13'); // Wednesday
    expect(isoWeekStart('2026-07-19')).toBe('2026-07-13'); // Sunday belongs to the SAME week
    expect(isoWeekStart('2026-07-20')).toBe('2026-07-20'); // next Monday starts a new week
  });

  it('crosses month and year boundaries', () => {
    expect(isoWeekStart('2026-01-01')).toBe('2025-12-29'); // Thu Jan 1 → Mon Dec 29
  });

  it('weeklyVolume counts only the ISO week of today (Sunday/Monday edges)', () => {
    const sessions = [
      session('2026-07-12', [{ name: 'Squat', sets: 1, reps: 1, weightKg: 100 }]), // previous Sunday
      session('2026-07-13', [{ name: 'Squat', sets: 1, reps: 1, weightKg: 10 }]), // Monday ✓
      session('2026-07-19', [{ name: 'Squat', sets: 1, reps: 1, weightKg: 1 }]), // Sunday ✓
      session('2026-07-20', [{ name: 'Squat', sets: 1, reps: 1, weightKg: 1000 }]), // next Monday
    ];
    expect(weeklyVolume(sessions, TODAY)).toBe(11);
    expect(sessionsThisWeek(sessions, TODAY).map((s) => s.date)).toEqual([
      '2026-07-13',
      '2026-07-19',
    ]);
    // On Sunday the week still reaches back to its Monday …
    expect(weeklyVolume(sessions, '2026-07-19')).toBe(11);
    // … and on the next Monday a fresh week begins.
    expect(weeklyVolume(sessions, '2026-07-20')).toBe(1000);
  });

  it('volumeByWeekday buckets Monday-first', () => {
    const sessions = [
      session('2026-07-13', [{ name: 'A', sets: 1, reps: 10, weightKg: 2 }]), // Mon → 20
      session('2026-07-15', [{ name: 'B', sets: 2, reps: 10 }]), // Wed → 20
      session('2026-07-15', [{ name: 'C', sets: 1, reps: 5, weightKg: 4 }], 'Legs'), // Wed → +20
    ];
    expect(volumeByWeekday(sessions, TODAY)).toEqual([20, 0, 40, 0, 0, 0, 0]);
  });
});

describe('personalRecords', () => {
  it('takes the max weight per exercise, case-insensitively', () => {
    const sessions = [
      session('2026-07-01', [{ name: 'Squat', sets: 3, reps: 5, weightKg: 100 }]),
      session('2026-07-08', [{ name: 'squat', sets: 3, reps: 5, weightKg: 110 }]),
      session('2026-07-10', [{ name: 'Bench', sets: 3, reps: 5, weightKg: 80 }]),
    ];
    expect(personalRecords(sessions)).toEqual([
      { name: 'Bench', weightKg: 80, date: '2026-07-10' },
      { name: 'Squat', weightKg: 110, date: '2026-07-08' }, // first-seen casing kept
    ]);
  });

  it('a tie keeps the EARLIEST date (when the record was first hit)', () => {
    const sessions = [
      session('2026-07-08', [{ name: 'Squat', sets: 1, reps: 1, weightKg: 110 }]),
      session('2026-07-01', [{ name: 'Squat', sets: 1, reps: 1, weightKg: 110 }]),
    ];
    expect(personalRecords(sessions)).toEqual([
      { name: 'Squat', weightKg: 110, date: '2026-07-01' },
    ]);
  });

  it('ignores bodyweight entries and blank names', () => {
    const sessions = [
      session('2026-07-01', [
        { name: 'Pull-up', sets: 3, reps: 10 },
        { name: '  ', sets: 1, reps: 1, weightKg: 50 },
      ]),
    ];
    expect(personalRecords(sessions)).toEqual([]);
  });
});

describe('units', () => {
  it('kgToLb uses the exact factor', () => {
    expect(kgToLb(100)).toBeCloseTo(220.462, 3);
    expect(kgToLb(0)).toBe(0);
  });

  it('formatWeight rounds to one decimal in the chosen unit', () => {
    expect(formatWeight(100, 'kg')).toBe('100 kg');
    expect(formatWeight(100, 'lb')).toBe('220.5 lb');
    expect(formatWeight(62.5, 'kg')).toBe('62.5 kg');
  });
});

describe('dates / factories / params', () => {
  it('localDayKey renders the LOCAL date (00:30 stays today – no UTC drift)', () => {
    expect(localDayKey(new Date(2026, 6, 15, 0, 30))).toBe('2026-07-15');
  });

  it('addDays and isValidDate behave on edges', () => {
    expect(addDays('2026-12-29', 7)).toBe('2027-01-05');
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('2026-07-15')).toBe(true);
  });

  it('makeSession trims the kind and starts without exercises', () => {
    const s = makeSession('  Push  ', TODAY);
    expect(s.kind).toBe('Push');
    expect(s.date).toBe(TODAY);
    expect(s.exercises).toEqual([]);
    expect(s.id.startsWith('session:')).toBe(true);
    expect(s.type).toBe('session');
  });

  it('logSessionParamsSchema validates kind and optional date', () => {
    expect(logSessionParamsSchema.safeParse({ kind: 'Legs' }).success).toBe(true);
    expect(logSessionParamsSchema.safeParse({ kind: 'Legs', date: '2026-07-15' }).success).toBe(
      true,
    );
    expect(logSessionParamsSchema.safeParse({ kind: '' }).success).toBe(false);
    expect(logSessionParamsSchema.safeParse({ kind: 'Legs', date: 'yesterday' }).success).toBe(
      false,
    );
  });
});

describe('buildWorkoutContext', () => {
  it('reports the empty state in both languages', () => {
    expect(buildWorkoutContext([], 'en', TODAY)).toBe('No workouts logged yet.');
    expect(buildWorkoutContext([], 'de', TODAY)).toBe('Noch keine Workouts erfasst.');
  });

  it('summarizes this week and the latest record (en)', () => {
    const sessions = [
      session('2026-07-13', [{ name: 'Squat', sets: 3, reps: 5, weightKg: 100 }]),
      session('2026-07-01', [{ name: 'Bench', sets: 3, reps: 5, weightKg: 80 }], 'Push'),
    ];
    const text = buildWorkoutContext(sessions, 'en', TODAY);
    expect(text).toContain('This week 1 session(s) (Push), volume ≈ 1500.');
    expect(text).toContain('Latest record: «Squat» 100 kg on 2026-07-13.');
  });

  it('uses German wording and the lb unit when asked (de)', () => {
    const sessions = [session('2026-07-14', [{ name: 'Squat', sets: 1, reps: 1, weightKg: 100 }])];
    const text = buildWorkoutContext(sessions, 'de', TODAY, 'lb');
    expect(text).toContain('Diese Woche 1 Einheit(en)');
    expect(text).toContain('«Squat» 220.5 lb am 2026-07-14.');
  });

  it('handles a week with sessions but no weight records', () => {
    const sessions = [session('2026-07-14', [{ name: 'Pull-up', sets: 3, reps: 10 }])];
    expect(buildWorkoutContext(sessions, 'en', TODAY)).toContain('No weight records yet.');
  });
});
