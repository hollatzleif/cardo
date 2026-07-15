import { describe, expect, it } from 'vitest';
import { daysUntil, pickUpcoming, ringProgress } from './countdown';

describe('daysUntil', () => {
  it('returns 0 for the same calendar day', () => {
    expect(daysUntil('2026-06-15', new Date(2026, 5, 15, 13, 45, 0))).toBe(0);
  });

  it('returns 1 for tomorrow, even shortly before midnight', () => {
    expect(daysUntil('2026-06-16', new Date(2026, 5, 15, 23, 59, 0))).toBe(1);
    expect(daysUntil('2026-06-16', new Date(2026, 5, 15, 0, 0, 0))).toBe(1);
  });

  it('returns -1 for yesterday', () => {
    expect(daysUntil('2026-06-14', new Date(2026, 5, 15, 0, 1, 0))).toBe(-1);
  });

  it('is independent of the time of day (calendar days, not 24h buckets)', () => {
    const morning = new Date(2026, 5, 15, 0, 0, 1);
    const evening = new Date(2026, 5, 15, 23, 59, 59);
    expect(daysUntil('2026-06-20', morning)).toBe(5);
    expect(daysUntil('2026-06-20', evening)).toBe(5);
  });

  it('crosses month and year boundaries', () => {
    expect(daysUntil('2026-07-01', new Date(2026, 5, 30, 12, 0, 0))).toBe(1);
    expect(daysUntil('2027-01-01', new Date(2026, 11, 31, 18, 0, 0))).toBe(1);
  });

  it('handles DST transition days as whole calendar days', () => {
    // Europe: DST starts on 2026-03-29 – that Sunday has only 23 hours.
    expect(daysUntil('2026-03-30', new Date(2026, 2, 28, 12, 0, 0))).toBe(2);
  });
});

describe('pickUpcoming (big/ring variants)', () => {
  const now = new Date(2026, 5, 15, 13, 45, 0);

  it('picks the nearest future countdown, regardless of input order', () => {
    const docs = [
      { id: 'far', targetDate: '2026-12-24' },
      { id: 'near', targetDate: '2026-06-20' },
      { id: 'past', targetDate: '2026-06-01' },
    ];
    expect(pickUpcoming(docs, now)?.id).toBe('near');
  });

  it('counts today as upcoming (0 days left)', () => {
    expect(pickUpcoming([{ id: 'today', targetDate: '2026-06-15' }], now)?.id).toBe('today');
  });

  it('returns null when everything is past or the list is empty', () => {
    expect(pickUpcoming([], now)).toBeNull();
    expect(pickUpcoming([{ targetDate: '2026-06-14' }, { targetDate: '2020-01-01' }], now)).toBeNull();
  });
});

describe('ringProgress (ring variant)', () => {
  const target = '2026-06-20';

  it('is 0 right at creation and grows towards 1 at the target', () => {
    const createdAt = new Date(2026, 5, 10, 0, 0, 0).toISOString();
    expect(ringProgress(createdAt, target, new Date(2026, 5, 10, 0, 0, 0))).toBe(0);
    expect(ringProgress(createdAt, target, new Date(2026, 5, 15, 0, 0, 0))).toBeCloseTo(0.5, 5);
    expect(ringProgress(createdAt, target, new Date(2026, 5, 20, 0, 0, 0))).toBe(1);
  });

  it('clamps to the 0..1 range', () => {
    const createdAt = new Date(2026, 5, 10, 0, 0, 0).toISOString();
    expect(ringProgress(createdAt, target, new Date(2026, 5, 9, 0, 0, 0))).toBe(0);
    expect(ringProgress(createdAt, target, new Date(2026, 6, 1, 0, 0, 0))).toBe(1);
  });

  it('falls back to a full ring without a usable createdAt or span', () => {
    const now = new Date(2026, 5, 15, 12, 0, 0);
    expect(ringProgress(undefined, target, now)).toBe(1);
    expect(ringProgress('not-a-date', target, now)).toBe(1);
    // Created AFTER the target (non-positive span) → full ring, no division blow-up.
    expect(ringProgress(new Date(2026, 6, 1).toISOString(), target, now)).toBe(1);
  });
});
