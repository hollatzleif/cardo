import { describe, expect, it } from 'vitest';
import { localDateKey } from './routine';

describe('localDateKey', () => {
  it('formats a local date as YYYY-MM-DD with zero padding', () => {
    expect(localDateKey(new Date(2026, 2, 5, 12, 0, 0))).toBe('2026-03-05');
    expect(localDateKey(new Date(2026, 10, 30, 12, 0, 0))).toBe('2026-11-30');
  });

  it('uses the LOCAL day, even when the UTC day differs', () => {
    // Just after local midnight and just before the next one – for any
    // machine not running on UTC, one of these two falls on a different
    // UTC calendar day than the local one.
    const afterMidnight = new Date(2026, 0, 1, 0, 30, 0);
    const beforeMidnight = new Date(2026, 11, 31, 23, 30, 0);

    expect(localDateKey(afterMidnight)).toBe('2026-01-01');
    expect(localDateKey(beforeMidnight)).toBe('2026-12-31');

    if (afterMidnight.getTimezoneOffset() !== 0 || beforeMidnight.getTimezoneOffset() !== 0) {
      const utcKeys = [
        afterMidnight.toISOString().slice(0, 10),
        beforeMidnight.toISOString().slice(0, 10),
      ];
      // At least one UTC day must differ from the local day …
      expect(utcKeys).not.toEqual(['2026-01-01', '2026-12-31']);
      // … and localDateKey must still report the local one for both.
      expect([localDateKey(afterMidnight), localDateKey(beforeMidnight)]).toEqual([
        '2026-01-01',
        '2026-12-31',
      ]);
    }
  });
});
