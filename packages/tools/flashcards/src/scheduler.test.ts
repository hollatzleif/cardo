import { describe, it, expect } from 'vitest';
import { defaultDeckOptions, newCardState, type DeckOptionsDoc } from './model';
import { fsrsReview, isSubDay, review, sm2Review, type Interval } from './scheduler';

function sm2Options(): DeckOptionsDoc {
  return { ...defaultDeckOptions(), scheduler: 'sm2' };
}
function fsrsOptions(): DeckOptionsDoc {
  return { ...defaultDeckOptions(), scheduler: 'fsrs' };
}

const days = (iv: Interval): number => ('days' in iv ? iv.days : iv.minutes / 1440);

describe('SM-2 (mirrors the Rust core)', () => {
  const opts = sm2Options();

  it('new + Good walks learning then graduates to 1 day', () => {
    let r = sm2Review(newCardState(), 'good', opts);
    expect(r.state.phase).toBe('learning');
    expect(r.interval).toEqual({ minutes: 10 });
    r = sm2Review(r.state, 'good', opts);
    expect(r.state.phase).toBe('review');
    expect(r.interval).toEqual({ days: 1 });
  });

  it('Easy in learning graduates immediately to 4 days', () => {
    const r = sm2Review(newCardState(), 'easy', opts);
    expect(r.state.phase).toBe('review');
    expect(r.interval).toEqual({ days: 4 });
  });

  it('review Good grows by ease (4 * 2.5 = 10)', () => {
    const graduated = sm2Review(newCardState(), 'easy', opts).state; // review, 4 days, ease 2.5
    const r = sm2Review(graduated, 'good', opts);
    expect(r.interval).toEqual({ days: 10 });
  });

  it('Again in review lapses into relearning and drops ease', () => {
    const graduated = sm2Review(newCardState(), 'easy', opts).state;
    const r = sm2Review(graduated, 'again', opts);
    expect(r.state.phase).toBe('relearning');
    expect(r.state.lapses).toBe(1);
    expect(r.state.ease).toBeLessThan(graduated.ease);
    expect(r.interval).toEqual({ minutes: 10 });
  });

  it('ease never drops below 1.3', () => {
    let s = sm2Review(newCardState(), 'easy', opts).state;
    for (let i = 0; i < 20; i += 1) s = sm2Review(s, 'hard', opts).state;
    expect(s.ease).toBeGreaterThanOrEqual(1.3 - 1e-9);
  });
});

describe('FSRS (via ts-fsrs)', () => {
  const opts = fsrsOptions();
  const now = new Date('2026-07-17T09:00:00.000Z');

  it('a new card gains memory and orders the buttons', () => {
    const good = fsrsReview(newCardState(), 'good', opts, 0, now).state;
    expect(good.stability).toBeGreaterThan(0);
    expect(good.difficulty).toBeGreaterThanOrEqual(1);
    expect(good.difficulty).toBeLessThanOrEqual(10);

    const again = days(fsrsReview(good, 'again', opts, good.intervalDays, now).interval);
    const hard = days(fsrsReview(good, 'hard', opts, good.intervalDays, now).interval);
    const g = days(fsrsReview(good, 'good', opts, good.intervalDays, now).interval);
    const easy = days(fsrsReview(good, 'easy', opts, good.intervalDays, now).interval);
    expect(again).toBeLessThanOrEqual(hard);
    expect(hard).toBeLessThanOrEqual(g);
    expect(g).toBeLessThanOrEqual(easy);
  });

  it('higher desired retention does not schedule later', () => {
    const low = { ...opts, desiredRetention: 0.8 };
    const high = { ...opts, desiredRetention: 0.95 };
    const ivLow = days(fsrsReview(newCardState(), 'good', low, 0, now).interval);
    const ivHigh = days(fsrsReview(newCardState(), 'good', high, 0, now).interval);
    expect(ivLow).toBeGreaterThanOrEqual(ivHigh);
  });
});

describe('dispatcher', () => {
  it('picks the scheduler from the options', () => {
    const viaSm2 = review(newCardState(), 'easy', sm2Options());
    expect(viaSm2.interval).toEqual({ days: 4 });
    const viaFsrs = review(newCardState(), 'good', fsrsOptions(), {
      now: new Date('2026-07-17T09:00:00.000Z'),
    });
    expect(viaFsrs.state.stability).toBeGreaterThan(0);
  });

  it('isSubDay detects minutes', () => {
    expect(isSubDay({ minutes: 10 })).toBe(true);
    expect(isSubDay({ days: 3 })).toBe(false);
  });
});
