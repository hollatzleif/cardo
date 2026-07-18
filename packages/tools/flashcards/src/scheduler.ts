/**
 * Scheduling for the flashcards tool, in JS so it runs offline (browser,
 * self-tests, render-smoke) without the Tauri host. Two algorithms behind one
 * `review()` entry point:
 *   - SM-2: a faithful port of the (unit-tested) Rust `srs::sm2_review`.
 *   - FSRS: Anki's modern default, via the mature `ts-fsrs` library.
 * Both read/write the note's `CardState` (which also mirrors the Rust shape).
 */

import { fsrs, generatorParameters, Rating as FsrsRating, State, type Grade } from 'ts-fsrs';
import type { CardState, DeckOptionsDoc, Phase } from './model';
import type { Rating } from './session';

export type Interval = { minutes: number } | { days: number };
export interface ReviewResult {
  state: CardState;
  interval: Interval;
}

/* SM-2 constants not exposed as deck options (Anki defaults). */
const MIN_EASE = 1.3;
const EASY_BONUS = 1.3;
const HARD_FACTOR = 1.2;
const LAPSE_FACTOR = 0.0;
const MIN_INTERVAL = 1;

function roundDays(x: number): number {
  return Math.max(1, Math.round(x));
}

function stepMinutes(steps: number[], idx: number): number {
  return steps[idx] ?? steps[steps.length - 1] ?? 1;
}

/* ── SM-2 (ported from cardo-core/src/srs.rs) ─────────────────────────────── */

function graduate(s: CardState, options: DeckOptionsDoc, relearning: boolean, easy: boolean): ReviewResult {
  s.phase = 'review';
  s.step = 0;
  s.reps += 1;
  if (relearning) {
    if (easy) s.intervalDays += 1;
  } else {
    s.intervalDays = easy ? options.easyIntervalDays : options.graduatingIntervalDays;
  }
  s.intervalDays = Math.max(s.intervalDays, MIN_INTERVAL);
  return { state: s, interval: { days: s.intervalDays } };
}

function stepThrough(
  s: CardState,
  rating: Rating,
  steps: number[],
  options: DeckOptionsDoc,
  relearning: boolean,
): ReviewResult {
  const last = Math.max(0, steps.length - 1);
  switch (rating) {
    case 'again':
      s.step = 0;
      return { state: s, interval: { minutes: stepMinutes(steps, 0) } };
    case 'hard':
      return { state: s, interval: { minutes: stepMinutes(steps, s.step) } };
    case 'good':
      if (s.step >= last) return graduate(s, options, relearning, false);
      s.step += 1;
      return { state: s, interval: { minutes: stepMinutes(steps, s.step) } };
    case 'easy':
      return graduate(s, options, relearning, true);
    default:
      return { state: s, interval: { minutes: stepMinutes(steps, s.step) } };
  }
}

function reviewAnswer(s: CardState, rating: Rating, options: DeckOptionsDoc): ReviewResult {
  const prev = Math.max(1, s.intervalDays);
  switch (rating) {
    case 'again':
      s.lapses += 1;
      s.ease = Math.max(MIN_EASE, s.ease - 0.2);
      s.phase = 'relearning';
      s.step = 0;
      s.intervalDays = Math.max(MIN_INTERVAL, roundDays(prev * LAPSE_FACTOR));
      return { state: s, interval: { minutes: stepMinutes(options.relearningStepsMin, 0) } };
    case 'hard':
      s.ease = Math.max(MIN_EASE, s.ease - 0.15);
      s.intervalDays = Math.max(prev + 1, roundDays(prev * HARD_FACTOR));
      s.reps += 1;
      return { state: s, interval: { days: s.intervalDays } };
    case 'easy':
      s.ease = Math.max(MIN_EASE, s.ease + 0.15);
      s.intervalDays = Math.max(prev + 1, roundDays(prev * s.ease * EASY_BONUS));
      s.reps += 1;
      return { state: s, interval: { days: s.intervalDays } };
    case 'good':
    default:
      s.intervalDays = Math.max(prev + 1, roundDays(prev * s.ease));
      s.reps += 1;
      return { state: s, interval: { days: s.intervalDays } };
  }
}

export function sm2Review(state: CardState, rating: Rating, options: DeckOptionsDoc): ReviewResult {
  const s: CardState = { ...state };
  if (s.phase === 'new') {
    s.phase = 'learning';
    s.step = 0;
  }
  switch (s.phase) {
    case 'learning':
      return stepThrough(s, rating, options.learningStepsMin, options, false);
    case 'relearning':
      return stepThrough(s, rating, options.relearningStepsMin, options, true);
    default:
      return reviewAnswer(s, rating, options);
  }
}

/* ── FSRS (via ts-fsrs) ───────────────────────────────────────────────────── */

const PHASE_TO_STATE: Record<Phase, State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
};
const STATE_TO_PHASE: Record<number, Phase> = {
  [State.New]: 'new',
  [State.Learning]: 'learning',
  [State.Review]: 'review',
  [State.Relearning]: 'relearning',
};
const RATING_TO_FSRS: Record<Rating, Grade> = {
  again: FsrsRating.Again,
  hard: FsrsRating.Hard,
  good: FsrsRating.Good,
  easy: FsrsRating.Easy,
};

export function fsrsReview(
  state: CardState,
  rating: Rating,
  options: DeckOptionsDoc,
  elapsedDays: number,
  now: Date,
): ReviewResult {
  const scheduler = fsrs(generatorParameters({ request_retention: options.desiredRetention }));
  const card = {
    due: now,
    stability: state.stability,
    difficulty: state.difficulty,
    elapsed_days: elapsedDays,
    scheduled_days: state.intervalDays,
    learning_steps: state.step,
    reps: state.reps,
    lapses: state.lapses,
    state: PHASE_TO_STATE[state.phase],
    last_review: undefined,
  };
  const { card: next } = scheduler.next(card, now, RATING_TO_FSRS[rating]);

  const s: CardState = {
    ...state,
    phase: STATE_TO_PHASE[next.state] ?? 'review',
    stability: next.stability,
    difficulty: next.difficulty,
    intervalDays: next.scheduled_days,
    step: next.learning_steps,
    reps: next.reps,
    lapses: next.lapses,
  };
  if (next.scheduled_days >= 1) {
    return { state: s, interval: { days: next.scheduled_days } };
  }
  const minutes = Math.max(1, Math.round((next.due.getTime() - now.getTime()) / 60_000));
  return { state: s, interval: { minutes } };
}

/* ── Dispatcher ───────────────────────────────────────────────────────────── */

export function review(
  state: CardState,
  rating: Rating,
  options: DeckOptionsDoc,
  extra?: { elapsedDays?: number; now?: Date },
): ReviewResult {
  if (options.scheduler === 'sm2') return sm2Review(state, rating, options);
  return fsrsReview(state, rating, options, extra?.elapsedDays ?? 0, extra?.now ?? new Date());
}

export function isSubDay(interval: Interval): boolean {
  return 'minutes' in interval;
}
