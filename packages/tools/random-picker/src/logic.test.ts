import { describe, expect, it } from 'vitest';
import {
  buildPickerContext,
  clampWeight,
  coinFlip,
  defaultRandomInts,
  mergeOptions,
  migrateLegacyItems,
  parseItems,
  randomInRange,
  rollDice,
  secureRandomInt,
  shuffleAll,
  weightedPickIndex,
  weightedPickN,
  yesNo,
  type LegacyListDoc,
  type PickerStateDoc,
  type RandomInts,
} from './logic';

/** Deterministic injected source: returns the queued values in order. */
function queued(...values: number[]): RandomInts {
  const queue = [...values];
  return (count, max) => Array.from({ length: count }, () => (queue.shift() ?? 0) % max);
}

/** Single-int flavor of `queued` for the `randomInt`-style callbacks. */
function queuedInt(...values: number[]): (maxExclusive: number) => number {
  const queue = [...values];
  return (max) => (queue.shift() ?? 0) % max;
}

describe('clampWeight', () => {
  it('clamps to the integer range 1..10', () => {
    expect(clampWeight(0)).toBe(1);
    expect(clampWeight(1)).toBe(1);
    expect(clampWeight(10)).toBe(10);
    expect(clampWeight(99)).toBe(10);
    expect(clampWeight(3.6)).toBe(4);
  });

  it('turns junk into the default weight 1', () => {
    expect(clampWeight(undefined)).toBe(1);
    expect(clampWeight('5')).toBe(1);
    expect(clampWeight(Number.NaN)).toBe(1);
    expect(clampWeight(Number.POSITIVE_INFINITY)).toBe(1);
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

describe('mergeOptions', () => {
  it('keeps weights for surviving texts and defaults new ones to 1', () => {
    const previous = [
      { text: 'a', weight: 5 },
      { text: 'b', weight: 2 },
    ];
    expect(mergeOptions(['b', 'c', 'a'], previous)).toEqual([
      { text: 'b', weight: 2 },
      { text: 'c', weight: 1 },
      { text: 'a', weight: 5 },
    ]);
  });

  it('matches duplicate texts in order, consuming previous entries', () => {
    const previous = [
      { text: 'x', weight: 3 },
      { text: 'x', weight: 7 },
    ];
    expect(mergeOptions(['x', 'x', 'x'], previous)).toEqual([
      { text: 'x', weight: 3 },
      { text: 'x', weight: 7 },
      { text: 'x', weight: 1 },
    ]);
  });

  it('sanitizes out-of-range stored weights', () => {
    expect(mergeOptions(['a'], [{ text: 'a', weight: 99 }])).toEqual([{ text: 'a', weight: 10 }]);
  });
});

describe('migrateLegacyItems', () => {
  const legacy = (over: Partial<LegacyListDoc>): LegacyListDoc => ({
    id: 'list:x',
    type: 'list',
    name: 'Dinner',
    items: ['pizza', 'pasta'],
    removeOnPick: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  it('imports the FIRST list as weight-1 options', () => {
    const lists = [legacy({}), legacy({ id: 'list:y', items: ['ignored'] })];
    expect(migrateLegacyItems(lists)).toEqual([
      { text: 'pizza', weight: 1 },
      { text: 'pasta', weight: 1 },
    ]);
  });

  it('returns no options when nothing is there', () => {
    expect(migrateLegacyItems([])).toEqual([]);
  });
});

describe('weightedPickIndex', () => {
  it('rejects empty, negative, non-integer and all-zero weights', () => {
    expect(weightedPickIndex([], queuedInt(0))).toBeNull();
    expect(weightedPickIndex([1, -1], queuedInt(0))).toBeNull();
    expect(weightedPickIndex([1, 0.5], queuedInt(0))).toBeNull();
    expect(weightedPickIndex([0, 0], queuedInt(0))).toBeNull();
  });

  it('maps the cumulative ranges exactly: weights [2,1,3] over 0..5', () => {
    // targets 0,1 → index 0; target 2 → index 1; targets 3,4,5 → index 2
    for (const [target, index] of [
      [0, 0],
      [1, 0],
      [2, 1],
      [3, 2],
      [5, 2],
    ] as const) {
      expect(weightedPickIndex([2, 1, 3], () => target)).toBe(index);
    }
  });

  it('asks the source for exactly the total weight and clamps stray values', () => {
    let seenMax = -1;
    expect(
      weightedPickIndex([4, 6], (max) => {
        seenMax = max;
        return 4;
      }),
    ).toBe(1);
    expect(seenMax).toBe(10);
    expect(weightedPickIndex([4, 6], () => 99)).toBe(1); // defensive clamp
    expect(weightedPickIndex([4, 6], () => -1)).toBe(0);
  });

  it('never picks zero-weight options and stays inside bounds (real source)', () => {
    const weights = [0, 3, 0, 1];
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 400; i++) {
      const index = weightedPickIndex(weights, secureRandomInt);
      expect(index).not.toBeNull();
      expect(index!).toBeGreaterThanOrEqual(0);
      expect(index!).toBeLessThan(4);
      counts[index!] = (counts[index!] ?? 0) + 1;
    }
    expect(counts[0]).toBe(0);
    expect(counts[2]).toBe(0);
    expect(counts[1]! + counts[3]!).toBe(400);
    // Distribution sanity: P(1)=0.75 → with n=400 the count is essentially
    // never below 240 or above 360 (>6σ from the mean of 300).
    expect(counts[1]!).toBeGreaterThan(240);
    expect(counts[1]!).toBeLessThan(360);
  });
});

describe('weightedPickN', () => {
  it('rejects mismatched lengths and invalid weights', () => {
    expect(weightedPickN(['a', 'b'], [1], 1, queued(0))).toBeNull();
    expect(weightedPickN(['a'], [-1], 1, queued(0))).toBeNull();
    expect(weightedPickN(['a'], [1.5], 1, queued(0))).toBeNull();
  });

  it('draws without replacement, deterministically with an injected source', () => {
    // weights [1,1,1]: first draw target 2 → 'c'; then [a,b] target 0 → 'a'.
    expect(weightedPickN(['a', 'b', 'c'], [1, 1, 1], 2, queued(2, 0))).toEqual(['c', 'a']);
  });

  it('clamps n to the number of positively weighted options', () => {
    const picked = weightedPickN(['a', 'b', 'zero'], [1, 1, 0], 99, defaultRandomInts);
    expect(picked).not.toBeNull();
    expect([...picked!].sort()).toEqual(['a', 'b']); // zero-weight never drawn
    expect(weightedPickN(['a'], [1], -3, defaultRandomInts)).toEqual([]);
  });

  it('returns distinct entries with the real source', () => {
    const options = ['a', 'b', 'c', 'd', 'e'];
    for (let i = 0; i < 50; i++) {
      const picked = weightedPickN(options, [1, 2, 3, 4, 5], 3, defaultRandomInts);
      expect(picked).not.toBeNull();
      expect(picked!.length).toBe(3);
      expect(new Set(picked).size).toBe(3);
      for (const p of picked!) expect(options).toContain(p);
    }
  });
});

describe('shuffleAll', () => {
  it('permutes deterministically with an injected source and never mutates', () => {
    const input = ['a', 'b', 'c', 'd'];
    // i=3: j=1 → swap b/d; i=2: j=0 → swap a/c; i=1: j=1 → no-op
    expect(shuffleAll(input, queued(1, 0, 1))).toEqual(['c', 'd', 'a', 'b']);
    expect(input).toEqual(['a', 'b', 'c', 'd']);
  });

  it('handles empty and single-item lists', () => {
    expect(shuffleAll([], defaultRandomInts)).toEqual([]);
    expect(shuffleAll(['solo'], defaultRandomInts)).toEqual(['solo']);
  });

  it('always yields a permutation and reaches multiple orders (real source)', () => {
    const input = [1, 2, 3, 4, 5];
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const out = shuffleAll(input, defaultRandomInts);
      expect([...out].sort((a, b) => a - b)).toEqual(input);
      seen.add(out.join(','));
    }
    expect(seen.size).toBeGreaterThan(1); // not the identity every time
  });
});

describe('randomInRange', () => {
  it('is inclusive on both ends', () => {
    expect(randomInRange(3, 5, queuedInt(0))).toBe(3);
    expect(randomInRange(3, 5, queuedInt(2))).toBe(5);
    expect(randomInRange(7, 7, queuedInt(0))).toBe(7);
  });

  it('forgives swapped bounds and handles negatives', () => {
    expect(randomInRange(5, 3, queuedInt(1))).toBe(4);
    expect(randomInRange(-2, 2, queuedInt(0))).toBe(-2);
    expect(randomInRange(-5, -5, queuedInt(0))).toBe(-5);
  });

  it('snaps fractional bounds inwards and rejects empty ranges', () => {
    expect(randomInRange(1.2, 2.9, queuedInt(0))).toBe(2); // only 2 fits
    expect(randomInRange(1.2, 1.9, queuedInt(0))).toBeNull(); // no integer inside
    expect(randomInRange(Number.NaN, 5, queuedInt(0))).toBeNull();
    expect(randomInRange(Number.POSITIVE_INFINITY, 5, queuedInt(0))).toBeNull();
  });

  it('stays inside the range with the real source', () => {
    for (let i = 0; i < 200; i++) {
      const n = randomInRange(-3, 3, secureRandomInt);
      expect(n).not.toBeNull();
      expect(n!).toBeGreaterThanOrEqual(-3);
      expect(n!).toBeLessThanOrEqual(3);
      expect(Number.isInteger(n!)).toBe(true);
    }
  });
});

describe('coinFlip', () => {
  it('maps 0 → heads, 1 → tails', () => {
    expect(coinFlip(() => 0)).toBe('heads');
    expect(coinFlip(() => 1)).toBe('tails');
  });

  it('produces both sides with the real source', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(coinFlip(secureRandomInt));
    expect(seen).toEqual(new Set(['heads', 'tails']));
  });
});

describe('yesNo', () => {
  it('maps 0/1/2 to yes/no/maybe', () => {
    expect(yesNo(false, () => 0)).toBe('yes');
    expect(yesNo(false, () => 1)).toBe('no');
    expect(yesNo(true, () => 2)).toBe('maybe');
  });

  it('never answers maybe without the third option', () => {
    for (let i = 0; i < 100; i++) {
      expect(['yes', 'no']).toContain(yesNo(false, secureRandomInt));
    }
    const withMaybe = new Set<string>();
    for (let i = 0; i < 200; i++) withMaybe.add(yesNo(true, secureRandomInt));
    expect(withMaybe).toEqual(new Set(['yes', 'no', 'maybe']));
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
  const state = (over: Partial<PickerStateDoc>): PickerStateDoc => ({
    id: 'state',
    type: 'state',
    options: [
      { text: 'pizza', weight: 1 },
      { text: 'pasta', weight: 3 },
    ],
    mode: 'wheel',
    ...over,
  });

  it('mentions the empty state in both languages', () => {
    expect(buildPickerContext(null, 'en')).toContain('no options');
    expect(buildPickerContext(null, 'de')).toContain('keine Optionen');
    expect(buildPickerContext(state({ options: [] }), 'en')).toContain('no options');
  });

  it('lists mode, count and a weighted preview', () => {
    const text = buildPickerContext(state({}), 'en');
    expect(text).toContain('mode: wheel');
    expect(text).toContain('2 option(s)');
    expect(text).toContain('pizza');
    expect(text).toContain('pasta (×3)'); // weight ≠ 1 is surfaced
    expect(text).not.toContain('pizza (×'); // weight 1 stays plain
  });

  it('includes the last result when present', () => {
    expect(buildPickerContext(state({ lastResult: 'pasta' }), 'en')).toContain('Last result: pasta');
    expect(buildPickerContext(state({ lastResult: 'pasta' }), 'de')).toContain(
      'Letztes Ergebnis: pasta',
    );
  });
});
