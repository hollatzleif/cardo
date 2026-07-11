import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  STATE_DOC_ID,
  durationFor,
  formatTime,
  initialState,
  nextPhase,
  remainingNow,
} from './logic';
import type { PomodoroSettings, PomodoroState } from './logic';

const settings: PomodoroSettings = { ...DEFAULT_SETTINGS };

describe('durationFor', () => {
  it('maps each phase to its configured minutes', () => {
    expect(durationFor('work', settings)).toBe(25 * 60);
    expect(durationFor('short-break', settings)).toBe(5 * 60);
    expect(durationFor('long-break', settings)).toBe(15 * 60);
  });

  it('respects custom settings', () => {
    const custom = { ...settings, workMinutes: 50, shortBreakMinutes: 10 };
    expect(durationFor('work', custom)).toBe(50 * 60);
    expect(durationFor('short-break', custom)).toBe(10 * 60);
  });
});

describe('initialState', () => {
  it('starts paused on a fresh work phase with the id stored inside the doc', () => {
    const state = initialState(settings);
    expect(state.id).toBe(STATE_DOC_ID);
    expect(state.phase).toBe('work');
    expect(state.running).toBe(false);
    expect(state.endsAt).toBeNull();
    expect(state.completedCycles).toBe(0);
    expect(state.remainingSeconds).toBe(25 * 60);
  });
});

describe('nextPhase', () => {
  it('advances work → short-break and counts the cycle', () => {
    const next = nextPhase(initialState(settings), settings);
    expect(next.phase).toBe('short-break');
    expect(next.completedCycles).toBe(1);
    expect(next.remainingSeconds).toBe(5 * 60);
  });

  it('advances the 4th completed work cycle → long-break', () => {
    const state: PomodoroState = {
      ...initialState(settings),
      completedCycles: settings.cyclesUntilLongBreak - 1,
    };
    const next = nextPhase(state, settings);
    expect(next.phase).toBe('long-break');
    expect(next.completedCycles).toBe(settings.cyclesUntilLongBreak);
    expect(next.remainingSeconds).toBe(15 * 60);
  });

  it('advances any break → work', () => {
    const shortBreak: PomodoroState = { ...initialState(settings), phase: 'short-break' };
    const longBreak: PomodoroState = { ...initialState(settings), phase: 'long-break' };
    expect(nextPhase(shortBreak, settings).phase).toBe('work');
    expect(nextPhase(longBreak, settings).phase).toBe('work');
  });

  it('always returns a paused state (the user starts the next phase manually)', () => {
    let state = initialState(settings);
    for (let i = 0; i < 10; i += 1) {
      state = nextPhase({ ...state, running: true, endsAt: new Date().toISOString() }, settings);
      expect(state.running).toBe(false);
      expect(state.endsAt).toBeNull();
    }
  });

  it('honors a custom long-break interval', () => {
    const custom = { ...settings, cyclesUntilLongBreak: 2 };
    const afterFirst = nextPhase(initialState(custom), custom);
    expect(afterFirst.phase).toBe('short-break');
    const secondWork: PomodoroState = { ...afterFirst, phase: 'work' };
    expect(nextPhase(secondWork, custom).phase).toBe('long-break');
  });
});

describe('remainingNow', () => {
  it('returns the stored remainder while paused', () => {
    const state: PomodoroState = { ...initialState(settings), remainingSeconds: 90 };
    expect(remainingNow(state, Date.now())).toBe(90);
  });

  it('derives the remainder from endsAt while running', () => {
    const now = Date.parse('2026-07-11T12:00:00.000Z');
    const state: PomodoroState = {
      ...initialState(settings),
      running: true,
      endsAt: '2026-07-11T12:01:30.000Z',
    };
    expect(remainingNow(state, now)).toBe(90);
  });

  it('never goes below zero after the deadline passed', () => {
    const now = Date.parse('2026-07-11T12:10:00.000Z');
    const state: PomodoroState = {
      ...initialState(settings),
      running: true,
      endsAt: '2026-07-11T12:00:00.000Z',
    };
    expect(remainingNow(state, now)).toBe(0);
  });
});

describe('formatTime', () => {
  it('formats mm:ss with padding', () => {
    expect(formatTime(0)).toBe('00:00');
    expect(formatTime(5)).toBe('00:05');
    expect(formatTime(65)).toBe('01:05');
    expect(formatTime(25 * 60)).toBe('25:00');
    expect(formatTime(125 * 60)).toBe('125:00');
  });

  it('clamps negative input to zero', () => {
    expect(formatTime(-3)).toBe('00:00');
  });
});
