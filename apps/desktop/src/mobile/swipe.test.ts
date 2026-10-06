// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { swipeAllowedFrom, swipeDirection } from './swipe';

describe('page swipe', () => {
  it('recognises quick horizontal swipes only', () => {
    expect(swipeDirection(-120, 10, 200)).toBe(1);
    expect(swipeDirection(120, -10, 200)).toBe(-1);
    expect(swipeDirection(-40, 0, 200)).toBe(0);
    expect(swipeDirection(-120, 80, 200)).toBe(0);
    expect(swipeDirection(-120, 0, 1500)).toBe(0);
  });

  it('ignores gestures that start in inputs and sliders', () => {
    const range = document.createElement('input');
    range.type = 'range';
    expect(swipeAllowedFrom(range)).toBe(false);
    expect(swipeAllowedFrom(document.createElement('div'))).toBe(true);
  });
});
