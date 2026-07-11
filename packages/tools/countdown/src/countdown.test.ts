import { describe, expect, it } from 'vitest';
import { daysUntil } from './countdown';

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
