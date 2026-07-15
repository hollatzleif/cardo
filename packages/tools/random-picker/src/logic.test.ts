import { describe, expect, it } from 'vitest';
import {
  buildPickerContext,
  defaultRandomInts,
  parseItems,
  pickIndex,
  removeAt,
  rollDice,
  type PickerListDoc,
  type RandomInts,
} from './logic';

/** Deterministic injected source: returns the queued values in order. */
function queued(...values: number[]): RandomInts {
  const queue = [...values];
  return (count, max) => Array.from({ length: count }, () => (queue.shift() ?? 0) % max);
}

describe('pickIndex', () => {
  it('returns null for empty or invalid lengths', () => {
    expect(pickIndex(0, () => 0)).toBeNull();
    expect(pickIndex(-3, () => 0)).toBeNull();
    expect(pickIndex(2.5, () => 0)).toBeNull();
  });

  it('passes the length as exclusive bound and clamps stray values', () => {
    let seenMax = -1;
    expect(
      pickIndex(5, (max) => {
        seenMax = max;
        return 3;
      }),
    ).toBe(3);
    expect(seenMax).toBe(5);
    expect(pickIndex(5, () => 99)).toBe(4); // defensive clamp
    expect(pickIndex(5, () => -1)).toBe(0);
  });

  it('covers the full range uniformly with the real source', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 300; i++) {
      const idx = pickIndex(4, (max) => defaultRandomInts(1, max)[0] ?? 0);
      expect(idx).not.toBeNull();
      expect(idx!).toBeGreaterThanOrEqual(0);
      expect(idx!).toBeLessThan(4);
      seen.add(idx!);
    }
    expect(seen.size).toBe(4); // every option reachable
  });
});

describe('removeAt', () => {
  it('removes exactly the given index', () => {
    expect(removeAt(['a', 'b', 'c'], 1)).toEqual(['a', 'c']);
    expect(removeAt(['a'], 0)).toEqual([]);
  });

  it('ignores out-of-range indices and never mutates', () => {
    const items = ['a', 'b'];
    expect(removeAt(items, -1)).toEqual(['a', 'b']);
    expect(removeAt(items, 2)).toEqual(['a', 'b']);
    expect(removeAt(items, 0.5)).toEqual(['a', 'b']);
    expect(items).toEqual(['a', 'b']);
  });
});

describe('parseItems', () => {
  it('splits on newlines and commas, trims, drops empties', () => {
    expect(parseItems('pizza\npasta, salad\n\n ,  sushi  ')).toEqual([
      'pizza',
      'pasta',
      'salad',
      'sushi',
    ]);
  });

  it('returns an empty list for blank input', () => {
    expect(parseItems('')).toEqual([]);
    expect(parseItems(' \n , \n')).toEqual([]);
  });
});

describe('rollDice', () => {
  it('rejects malformed specs', () => {
    for (const bad of ['d6', '2d', '0d6', '21d6', '', '2x6', 'dd', '2d6d6', '1.5d6']) {
      expect(rollDice(bad, queued(0)), `spec "${bad}"`).toBeNull();
    }
  });

  it('enforces the caps N ≤ 20, 2 ≤ M ≤ 1000', () => {
    expect(rollDice('20d1000', queued(...new Array<number>(20).fill(0)))).not.toBeNull();
    expect(rollDice('21d6', queued())).toBeNull();
    expect(rollDice('2d1001', queued())).toBeNull();
    expect(rollDice('2d1', queued())).toBeNull();
    expect(rollDice('0d6', queued())).toBeNull();
  });

  it('rolls with injected randomness: faces are value+1, total adds up', () => {
    const roll = rollDice('2d6', queued(0, 5));
    expect(roll).toEqual({ count: 2, sides: 6, rolls: [1, 6], total: 7 });
  });

  it('accepts surrounding whitespace and a capital D', () => {
    expect(rollDice(' 3D8 ', queued(1, 2, 3))).toEqual({
      count: 3,
      sides: 8,
      rolls: [2, 3, 4],
      total: 9,
    });
  });

  it('stays inside 1..M with the real source', () => {
    const roll = rollDice('20d6', defaultRandomInts);
    expect(roll).not.toBeNull();
    for (const face of roll!.rolls) {
      expect(face).toBeGreaterThanOrEqual(1);
      expect(face).toBeLessThanOrEqual(6);
    }
    expect(roll!.total).toBe(roll!.rolls.reduce((a, b) => a + b, 0));
  });
});

describe('buildPickerContext', () => {
  const list = (over: Partial<PickerListDoc>): PickerListDoc => ({
    id: 'list:x',
    type: 'list',
    name: 'Dinner',
    items: ['pizza', 'pasta'],
    removeOnPick: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  it('mentions the empty state in both languages', () => {
    expect(buildPickerContext([], 'en')).toContain('no lists');
    expect(buildPickerContext([], 'de')).toContain('keine Listen');
  });

  it('lists names, counts and a preview', () => {
    const text = buildPickerContext([list({})], 'en');
    expect(text).toContain('Dinner');
    expect(text).toContain('2 entries');
    expect(text).toContain('pizza');
  });

  it('flags remove-on-pick lists', () => {
    expect(buildPickerContext([list({ removeOnPick: true })], 'en')).toContain('removed once picked');
  });
});
