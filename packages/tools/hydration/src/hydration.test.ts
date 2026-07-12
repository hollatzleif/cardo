import { describe, expect, it } from 'vitest';
import { isInWindow, localDateKey } from './hydration';

describe('localDateKey', () => {
  it('formats a local date as YYYY-MM-DD with zero padding', () => {
    expect(localDateKey(new Date(2026, 2, 5, 12, 0, 0))).toBe('2026-03-05');
    expect(localDateKey(new Date(2026, 10, 30, 12, 0, 0))).toBe('2026-11-30');
  });

  it('uses the LOCAL day, even right after local midnight', () => {
    expect(localDateKey(new Date(2026, 0, 1, 0, 30, 0))).toBe('2026-01-01');
    expect(localDateKey(new Date(2026, 11, 31, 23, 30, 0))).toBe('2026-12-31');
  });
});

describe('isInWindow', () => {
  const at = (h: number, m: number) => new Date(2026, 0, 15, h, m, 0);

  it('accepts times inside a same-day window (inclusive bounds)', () => {
    expect(isInWindow(at(9, 0), '09:00', '21:00')).toBe(true);
    expect(isInWindow(at(12, 30), '09:00', '21:00')).toBe(true);
    expect(isInWindow(at(21, 0), '09:00', '21:00')).toBe(true);
  });

  it('rejects times outside a same-day window', () => {
    expect(isInWindow(at(8, 59), '09:00', '21:00')).toBe(false);
    expect(isInWindow(at(21, 1), '09:00', '21:00')).toBe(false);
    expect(isInWindow(at(0, 0), '09:00', '21:00')).toBe(false);
  });

  it('supports windows crossing midnight (22:00–06:00)', () => {
    expect(isInWindow(at(22, 0), '22:00', '06:00')).toBe(true);
    expect(isInWindow(at(23, 59), '22:00', '06:00')).toBe(true);
    expect(isInWindow(at(0, 30), '22:00', '06:00')).toBe(true);
    expect(isInWindow(at(6, 0), '22:00', '06:00')).toBe(true);
    expect(isInWindow(at(6, 1), '22:00', '06:00')).toBe(false);
    expect(isInWindow(at(12, 0), '22:00', '06:00')).toBe(false);
    expect(isInWindow(at(21, 59), '22:00', '06:00')).toBe(false);
  });

  it('treats from === until as a 24h window', () => {
    expect(isInWindow(at(0, 0), '09:00', '09:00')).toBe(true);
    expect(isInWindow(at(17, 45), '09:00', '09:00')).toBe(true);
  });

  it('fails open on malformed times (reminders keep working)', () => {
    expect(isInWindow(at(3, 0), 'nonsense', '21:00')).toBe(true);
    expect(isInWindow(at(3, 0), '09:00', '25:99')).toBe(true);
  });
});
