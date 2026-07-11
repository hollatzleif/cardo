import { describe, expect, it } from 'vitest';
import { nextOccurrence } from './alarm';

describe('nextOccurrence', () => {
  it('fires today when the time is still ahead', () => {
    const now = new Date(2026, 0, 15, 6, 30, 0);
    const next = nextOccurrence('07:00', now);
    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(0);
    expect(next.getDate()).toBe(15);
    expect(next.getHours()).toBe(7);
    expect(next.getMinutes()).toBe(0);
  });

  it('fires tomorrow when the time already passed today', () => {
    const now = new Date(2026, 0, 15, 8, 0, 0);
    const next = nextOccurrence('07:00', now);
    expect(next.getDate()).toBe(16);
    expect(next.getHours()).toBe(7);
    expect(next.getMinutes()).toBe(0);
  });

  it('fires tomorrow when the time is exactly now', () => {
    const now = new Date(2026, 0, 15, 7, 0, 0);
    const next = nextOccurrence('07:00', now);
    expect(next.getDate()).toBe(16);
  });

  it('preserves minutes', () => {
    const now = new Date(2026, 0, 15, 6, 0, 0);
    const next = nextOccurrence('06:45', now);
    expect(next.getDate()).toBe(15);
    expect(next.getHours()).toBe(6);
    expect(next.getMinutes()).toBe(45);
  });

  it('rolls over month boundaries', () => {
    const now = new Date(2026, 0, 31, 23, 0, 0);
    const next = nextOccurrence('07:00', now);
    expect(next.getMonth()).toBe(1);
    expect(next.getDate()).toBe(1);
    expect(next.getHours()).toBe(7);
  });

  it('seconds and milliseconds are zeroed', () => {
    const now = new Date(2026, 0, 15, 6, 30, 12, 345);
    const next = nextOccurrence('07:00', now);
    expect(next.getSeconds()).toBe(0);
    expect(next.getMilliseconds()).toBe(0);
  });
});
