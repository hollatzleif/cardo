/**
 * Study-session engine for the flashcards tool. Pure and framework-free so it
 * unit-tests without React or Tauri. The actual scheduling maths live in the
 * Rust core (`srs_review` command); this engine only builds the due queue and
 * tracks progress/undo as the user answers.
 */

import type { CardDoc, CardState } from './model';

/** Answer buttons, matching the Rust `srs::Rating` serde values. */
export type Rating = 'again' | 'hard' | 'good' | 'easy';

/** Result the Rust `srs_review` command returns (interval is externally tagged). */
export interface ScheduleResult {
  state: CardState;
  interval: { minutes: number } | { days: number };
}

/** True when the scheduled interval is sub-day (a learning step this session). */
export function isSubDay(interval: ScheduleResult['interval']): boolean {
  return 'minutes' in interval;
}

/* ── Queue building ───────────────────────────────────────────────────────── */

export interface QueueLimits {
  newPerDay: number;
  reviewsPerDay: number;
}

function isDueLearning(card: CardDoc, nowIso: string): boolean {
  return (
    (card.state.phase === 'learning' || card.state.phase === 'relearning') &&
    (card.dueAt === null || card.dueAt <= nowIso)
  );
}

/**
 * The cards to study now, in order: due (re)learning first, then due reviews
 * (capped), then new cards (capped). Suspended and buried cards are excluded.
 */
export function buildQueue(
  cards: CardDoc[],
  limits: QueueLimits,
  today: string,
  nowIso: string,
): CardDoc[] {
  const live = cards.filter((c) => !c.suspended && !c.buried);
  const byCreated = (a: CardDoc, b: CardDoc): number => a.createdAt.localeCompare(b.createdAt);

  const learning = live.filter((c) => isDueLearning(c, nowIso)).sort(byCreated);
  const review = live
    .filter((c) => c.state.phase === 'review' && c.due <= today)
    .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : byCreated(a, b)))
    .slice(0, Math.max(0, limits.reviewsPerDay));
  const fresh = live
    .filter((c) => c.state.phase === 'new')
    .sort(byCreated)
    .slice(0, Math.max(0, limits.newPerDay));

  return [...learning, ...review, ...fresh];
}

export interface QueueCounts {
  learning: number;
  review: number;
  new: number;
}

export function queueCounts(queue: CardDoc[]): QueueCounts {
  const counts: QueueCounts = { learning: 0, review: 0, new: 0 };
  for (const card of queue) {
    if (card.state.phase === 'new') counts.new += 1;
    else if (card.state.phase === 'review') counts.review += 1;
    else counts.learning += 1;
  }
  return counts;
}

/* ── Session (immutable, undo via queue snapshots) ────────────────────────── */

export interface Session {
  /** Remaining cards; index 0 is the current card. */
  queue: CardDoc[];
  /** Prior queue snapshots, most recent last – powers undo. */
  past: CardDoc[][];
  answered: number;
}

export function startSession(
  cards: CardDoc[],
  limits: QueueLimits,
  today: string,
  nowIso: string,
): Session {
  return { queue: buildQueue(cards, limits, today, nowIso), past: [], answered: 0 };
}

export function currentCard(s: Session): CardDoc | null {
  return s.queue[0] ?? null;
}

export function remaining(s: Session): number {
  return s.queue.length;
}

/**
 * Record an answered card. `updated` is the card with its new scheduling state
 * (from the Rust scheduler); `requeue` = the card is due again this session
 * (a sub-day learning step) and goes to the back of the queue.
 */
export function recordAnswer(s: Session, updated: CardDoc, requeue: boolean): Session {
  const rest = s.queue.slice(1);
  return {
    queue: requeue ? [...rest, updated] : rest,
    past: [...s.past, s.queue],
    answered: s.answered + 1,
  };
}

export function canUndo(s: Session): boolean {
  return s.past.length > 0;
}

export function undo(s: Session): Session {
  const prev = s.past[s.past.length - 1];
  if (!prev) return s;
  return { queue: prev, past: s.past.slice(0, -1), answered: Math.max(0, s.answered - 1) };
}
