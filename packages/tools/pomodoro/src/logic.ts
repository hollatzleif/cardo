/**
 * Pomodoro phase state machine – pure functions, no DOM, no React.
 * Kept separate so self-tests and unit tests can exercise the logic directly.
 */

export type Phase = 'work' | 'short-break' | 'long-break';

export type PomodoroSettings = {
  workMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  cyclesUntilLongBreak: number;
  soundEnabled: boolean;
};

export const DEFAULT_SETTINGS: PomodoroSettings = {
  workMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  cyclesUntilLongBreak: 4,
  soundEnabled: true,
};

/**
 * Persisted timer state. query() returns doc bodies without ids,
 * so the doc id lives inside the document itself.
 */
export type PomodoroState = {
  id: string;
  phase: Phase;
  running: boolean;
  /** Authoritative while paused. */
  remainingSeconds: number;
  /** ISO timestamp – authoritative while running (survives restarts). */
  endsAt: string | null;
  completedCycles: number;
};

export const STATE_DOC_ID = 'state';

/** Full duration of a phase in seconds. */
export function durationFor(phase: Phase, settings: PomodoroSettings): number {
  switch (phase) {
    case 'work':
      return Math.max(1, Math.round(settings.workMinutes * 60));
    case 'short-break':
      return Math.max(1, Math.round(settings.shortBreakMinutes * 60));
    case 'long-break':
      return Math.max(1, Math.round(settings.longBreakMinutes * 60));
  }
}

/** Fresh state at the start of a work session. */
export function initialState(settings: PomodoroSettings): PomodoroState {
  return {
    id: STATE_DOC_ID,
    phase: 'work',
    running: false,
    remainingSeconds: durationFor('work', settings),
    endsAt: null,
    completedCycles: 0,
  };
}

/**
 * Advance to the next phase, PAUSED (the user starts the next phase manually).
 * work → short-break, except every Nth completed work cycle → long-break;
 * any break → work.
 */
export function nextPhase(state: PomodoroState, settings: PomodoroSettings): PomodoroState {
  const every = Math.max(1, Math.round(settings.cyclesUntilLongBreak));
  let completedCycles = state.completedCycles;
  let phase: Phase;
  if (state.phase === 'work') {
    completedCycles += 1;
    phase = completedCycles % every === 0 ? 'long-break' : 'short-break';
  } else {
    phase = 'work';
  }
  return {
    id: state.id,
    phase,
    running: false,
    remainingSeconds: durationFor(phase, settings),
    endsAt: null,
    completedCycles,
  };
}

/** Seconds left right now – derived from endsAt while running. */
export function remainingNow(state: PomodoroState, nowMs: number): number {
  if (state.running && state.endsAt) {
    return Math.max(0, Math.ceil((Date.parse(state.endsAt) - nowMs) / 1000));
  }
  return Math.max(0, state.remainingSeconds);
}

/** mm:ss (minutes can exceed 99 for very long custom sessions). */
export function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}
