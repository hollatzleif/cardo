import { describe, it, expect } from 'vitest';
import type { CardDoc, CardState } from './model';
import { newCardState } from './model';
import {
  buildQueue,
  canUndo,
  currentCard,
  isSubDay,
  queueCounts,
  recordAnswer,
  remaining,
  startSession,
  undo,
} from './session';

function card(
  id: string,
  over: Omit<Partial<CardDoc>, 'state'> & { state?: Partial<CardState> } = {},
): CardDoc {
  return {
    id,
    type: 'card',
    noteId: `note-${id}`,
    templateIndex: 0,
    deckId: 'd1',
    state: { ...newCardState(), ...(over.state ?? {}) },
    due: over.due ?? '2026-07-17',
    dueAt: over.dueAt ?? null,
    suspended: over.suspended ?? false,
    buried: over.buried ?? false,
    flag: 0,
    createdAt: over.createdAt ?? `2026-01-01T00:00:0${id}.000Z`,
  };
}

const TODAY = '2026-07-17';
const NOW = '2026-07-17T09:00:00.000Z';
const LIMITS = { newPerDay: 20, reviewsPerDay: 200 };

describe('buildQueue', () => {
  it('orders learning → review → new and skips suspended/buried', () => {
    const cards = [
      card('1', { state: { phase: 'new' } }),
      card('2', { state: { phase: 'review', intervalDays: 5 }, due: '2026-07-16' }),
      card('3', { state: { phase: 'learning' }, dueAt: '2026-07-17T08:00:00.000Z' }),
      card('4', { state: { phase: 'review', intervalDays: 5 }, suspended: true }),
      card('5', { state: { phase: 'new' }, buried: true }),
    ];
    const q = buildQueue(cards, LIMITS, TODAY, NOW);
    expect(q.map((c) => c.id)).toEqual(['3', '2', '1']);
  });

  it('excludes future reviews and future learning steps', () => {
    const cards = [
      card('1', { state: { phase: 'review', intervalDays: 5 }, due: '2026-07-20' }),
      // Learning step due at 23:00 is not yet due at 09:00 (NOW).
      card('2', { state: { phase: 'learning' }, dueAt: '2026-07-17T23:00:00.000Z' }),
    ];
    expect(buildQueue(cards, LIMITS, TODAY, NOW)).toEqual([]);
  });

  it('caps new and review cards by the daily limits', () => {
    const news = Array.from({ length: 5 }, (_, i) => card(`n${i}`, { state: { phase: 'new' } }));
    const revs = Array.from({ length: 5 }, (_, i) =>
      card(`r${i}`, { state: { phase: 'review', intervalDays: 3 }, due: '2026-07-16' }),
    );
    const q = buildQueue([...news, ...revs], { newPerDay: 2, reviewsPerDay: 3 }, TODAY, NOW);
    expect(q.filter((c) => c.state.phase === 'new')).toHaveLength(2);
    expect(q.filter((c) => c.state.phase === 'review')).toHaveLength(3);
  });
});

describe('queueCounts', () => {
  it('counts by phase', () => {
    const q = [
      card('1', { state: { phase: 'new' } }),
      card('2', { state: { phase: 'review', intervalDays: 1 } }),
      card('3', { state: { phase: 'relearning' } }),
    ];
    expect(queueCounts(q)).toEqual({ new: 1, review: 1, learning: 1 });
  });
});

describe('session flow', () => {
  it('advances through the queue and finishes', () => {
    const cards = [card('1', { state: { phase: 'new' } }), card('2', { state: { phase: 'new' } })];
    let s = startSession(cards, LIMITS, TODAY, NOW);
    expect(remaining(s)).toBe(2);
    expect(currentCard(s)!.id).toBe('1');

    // Answer card 1, graduates (no requeue).
    s = recordAnswer(s, { ...cards[0]!, state: { ...cards[0]!.state, phase: 'review' } }, false);
    expect(currentCard(s)!.id).toBe('2');
    expect(remaining(s)).toBe(1);

    s = recordAnswer(s, { ...cards[1]!, state: { ...cards[1]!.state, phase: 'review' } }, false);
    expect(currentCard(s)).toBeNull();
    expect(s.answered).toBe(2);
  });

  it('re-queues a learning card that is due again this session', () => {
    const cards = [card('1', { state: { phase: 'new' } }), card('2', { state: { phase: 'new' } })];
    let s = startSession(cards, LIMITS, TODAY, NOW);
    const learned = { ...cards[0]!, state: { ...cards[0]!.state, phase: 'learning' as const } };
    s = recordAnswer(s, learned, true); // sub-day step → back of queue
    expect(s.queue.map((c) => c.id)).toEqual(['2', '1']);
    expect(remaining(s)).toBe(2);
  });

  it('undo restores the previous queue and answered count', () => {
    const cards = [card('1', { state: { phase: 'new' } }), card('2', { state: { phase: 'new' } })];
    let s = startSession(cards, LIMITS, TODAY, NOW);
    expect(canUndo(s)).toBe(false);
    const before = s.queue;
    s = recordAnswer(s, { ...cards[0]!, state: { ...cards[0]!.state, phase: 'review' } }, false);
    expect(canUndo(s)).toBe(true);
    s = undo(s);
    expect(s.queue).toEqual(before);
    expect(s.answered).toBe(0);
    expect(canUndo(s)).toBe(false);
  });
});

describe('isSubDay', () => {
  it('detects minute intervals as sub-day', () => {
    expect(isSubDay({ minutes: 10 })).toBe(true);
    expect(isSubDay({ days: 4 })).toBe(false);
  });
});
