import { afterEach, describe, expect, it } from 'vitest';
import { dayDocId, elapsedSeconds, formatDuration, localDateKey } from './workclock';

const ORIGINAL_TZ = process.env.TZ;

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe('formatDuration', () => {
  it('formats sub-hour durations as MM:SS', () => {
    expect(formatDuration(0)).toBe('00:00');
    expect(formatDuration(9)).toBe('00:09');
    expect(formatDuration(59)).toBe('00:59');
    expect(formatDuration(60)).toBe('01:00');
    expect(formatDuration(61)).toBe('01:01');
    expect(formatDuration(3599)).toBe('59:59');
  });

  it('formats durations of an hour or more as H:MM:SS', () => {
    expect(formatDuration(3600)).toBe('1:00:00');
    expect(formatDuration(3661)).toBe('1:01:01');
    expect(formatDuration(45296)).toBe('12:34:56');
    expect(formatDuration(100 * 3600)).toBe('100:00:00');
  });

  it('clamps negative input and floors fractional seconds', () => {
    expect(formatDuration(-5)).toBe('00:00');
    expect(formatDuration(61.9)).toBe('01:01');
  });
});

describe('localDateKey', () => {
  it('formats the local calendar day as YYYY-MM-DD with zero padding', () => {
    expect(localDateKey(new Date(2026, 0, 5, 12, 0, 0))).toBe('2026-01-05');
    expect(localDateKey(new Date(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31');
  });

  it('uses the LOCAL day, not the UTC day (positive offset)', () => {
    process.env.TZ = 'Pacific/Kiritimati'; // UTC+14, no DST
    const d = new Date('2026-03-01T20:00:00Z'); // local: 2026-03-02 10:00
    expect(d.toISOString().slice(0, 10)).toBe('2026-03-01'); // UTC day…
    expect(localDateKey(d)).toBe('2026-03-02'); // …≠ local day
  });

  it('uses the LOCAL day, not the UTC day (negative offset)', () => {
    process.env.TZ = 'Pacific/Niue'; // UTC-11, no DST
    const d = new Date('2026-03-02T05:00:00Z'); // local: 2026-03-01 18:00
    expect(d.toISOString().slice(0, 10)).toBe('2026-03-02');
    expect(localDateKey(d)).toBe('2026-03-01');
  });
});

describe('elapsedSeconds', () => {
  it('returns whole elapsed seconds and never goes negative', () => {
    const start = new Date('2026-07-11T10:00:00Z');
    expect(elapsedSeconds(start.toISOString(), new Date('2026-07-11T10:00:05.900Z'))).toBe(5);
    expect(elapsedSeconds(start.toISOString(), new Date('2026-07-11T09:59:00Z'))).toBe(0);
  });
});

describe('dayDocId', () => {
  it('prefixes the date key', () => {
    expect(dayDocId('2026-07-11')).toBe('day:2026-07-11');
  });
});
