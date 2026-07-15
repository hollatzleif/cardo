import { describe, expect, it } from 'vitest';
import {
  buildCharset,
  clampLength,
  DEFAULT_OPTIONS,
  defaultRandomInts,
  entropyBits,
  generatePassphrase,
  generatePassword,
  MAX_LENGTH,
  MIN_LENGTH,
  passphraseEntropyBits,
  randomIntsFrom,
  strengthLabel,
  WORDLIST,
  type PasswordOptions,
  type RandomInts,
} from './logic';

/** Deterministic pseudo-random source for injection. */
function seq(start = 0, step = 7): RandomInts {
  let n = start;
  return (count, max) =>
    Array.from({ length: count }, () => {
      n += step;
      return n % max;
    });
}

const allOn: PasswordOptions = { ...DEFAULT_OPTIONS, length: 16 };

describe('buildCharset', () => {
  it('honors every toggle', () => {
    expect(
      buildCharset({ lower: true, upper: false, digits: false, symbols: false, excludeAmbiguous: false }),
    ).toEqual(['abcdefghijklmnopqrstuvwxyz']);
    const all = buildCharset(allOn);
    expect(all).toHaveLength(4);
    expect(all.join('')).toContain('a');
    expect(all.join('')).toContain('Z');
    expect(all.join('')).toContain('5');
    expect(all.join('')).toContain('!');
  });

  it('returns an empty list when nothing is enabled', () => {
    expect(
      buildCharset({ lower: false, upper: false, digits: false, symbols: false, excludeAmbiguous: false }),
    ).toEqual([]);
  });

  it('excludeAmbiguous removes exactly O 0 I l 1 |', () => {
    const pool = buildCharset({ ...allOn, excludeAmbiguous: true }).join('');
    for (const c of ['O', '0', 'I', 'l', '1', '|']) expect(pool).not.toContain(c);
    // Non-ambiguous neighbours stay in.
    for (const c of ['o', 'i', 'L', '2', '9']) expect(pool).toContain(c);
  });
});

describe('generatePassword', () => {
  it('produces the requested length and clamps to 8–128', () => {
    expect(generatePassword({ ...allOn, length: 20 }, seq())).toHaveLength(20);
    expect(generatePassword({ ...allOn, length: 4 }, seq())).toHaveLength(MIN_LENGTH);
    expect(generatePassword({ ...allOn, length: 999 }, seq())).toHaveLength(MAX_LENGTH);
    expect(clampLength(64)).toBe(64);
  });

  it('uses only characters from the enabled classes', () => {
    const digitsOnly = generatePassword(
      { length: 32, lower: false, upper: false, digits: true, symbols: false, excludeAmbiguous: false },
      seq(),
    );
    expect(digitsOnly).toMatch(/^[0-9]{32}$/);
  });

  it('honors the exclusion set at generation time', () => {
    const pw = generatePassword({ ...allOn, length: 128, excludeAmbiguous: true }, seq(3, 11));
    expect(pw).not.toBeNull();
    for (const c of ['O', '0', 'I', 'l', '1', '|']) expect(pw).not.toContain(c);
  });

  it('guarantees at least one character of every enabled class', () => {
    // An always-0 source would produce "aaaa…" without the guarantee.
    const zero: RandomInts = (count) => new Array<number>(count).fill(0);
    const pw = generatePassword({ ...allOn, length: 8 }, zero);
    expect(pw).toMatch(/[a-z]/);
    expect(pw).toMatch(/[A-Z]/);
    expect(pw).toMatch(/[0-9]/);
    expect(pw).toMatch(/[^a-zA-Z0-9]/);
  });

  it('is deterministic for an injected source', () => {
    expect(generatePassword(allOn, seq(1, 13))).toBe(generatePassword(allOn, seq(1, 13)));
  });

  it('returns null when no class is enabled', () => {
    expect(
      generatePassword(
        { length: 16, lower: false, upper: false, digits: false, symbols: false, excludeAmbiguous: false },
        seq(),
      ),
    ).toBeNull();
  });
});

describe('entropyBits', () => {
  it('is length · log2(poolSize)', () => {
    const digitsOnly: PasswordOptions = {
      length: 10,
      lower: false,
      upper: false,
      digits: true,
      symbols: false,
      excludeAmbiguous: false,
    };
    expect(entropyBits(digitsOnly)).toBeCloseTo(10 * Math.log2(10), 10);
    const lowerUpper: PasswordOptions = {
      length: 12,
      lower: true,
      upper: true,
      digits: false,
      symbols: false,
      excludeAmbiguous: false,
    };
    expect(entropyBits(lowerUpper)).toBeCloseTo(12 * Math.log2(52), 10);
  });

  it('is 0 for an empty pool', () => {
    expect(
      entropyBits({ length: 16, lower: false, upper: false, digits: false, symbols: false, excludeAmbiguous: false }),
    ).toBe(0);
  });
});

describe('strengthLabel', () => {
  it('maps bit thresholds to labels', () => {
    expect(strengthLabel(0)).toBe('weak');
    expect(strengthLabel(49.9)).toBe('weak');
    expect(strengthLabel(50)).toBe('ok');
    expect(strengthLabel(79.9)).toBe('ok');
    expect(strengthLabel(80)).toBe('strong');
    expect(strengthLabel(109.9)).toBe('strong');
    expect(strengthLabel(110)).toBe('excellent');
  });
});

describe('generatePassphrase', () => {
  it('ships a 200-word list without duplicates', () => {
    expect(WORDLIST).toHaveLength(200);
    expect(new Set(WORDLIST).size).toBe(WORDLIST.length);
  });

  it('honors word count and separator, words come from the list', () => {
    const phrase = generatePassphrase(5, '-', seq(2, 17));
    const words = phrase.split('-');
    expect(words).toHaveLength(5);
    for (const w of words) expect(WORDLIST).toContain(w);
  });

  it('clamps the word count to 3–12', () => {
    expect(generatePassphrase(1, ' ', seq()).split(' ')).toHaveLength(3);
    expect(generatePassphrase(99, ' ', seq()).split(' ')).toHaveLength(12);
  });

  it('entropy is words · log2(listLength)', () => {
    expect(passphraseEntropyBits(5)).toBeCloseTo(5 * Math.log2(200), 10);
  });
});

describe('randomIntsFrom (rejection sampling)', () => {
  it('rejects values above the largest fair multiple – no modulo bias', () => {
    // For max 3 the limit is floor(2^32 / 3) · 3 = 4294967295: that value
    // must be rejected (a naive modulo would map it to 0).
    const queue = [4294967295, 4, 5, 9];
    const fill = (buf: Uint32Array): void => {
      for (let i = 0; i < buf.length; i++) buf[i] = queue[i] ?? 0;
    };
    const ints = randomIntsFrom(fill)(4, 3);
    expect(ints).toEqual([4 % 3, 5 % 3, 9 % 3, 0]);
  });

  it('keeps drawing until enough values are accepted', () => {
    // First buffer is entirely rejectable for max 3; the second delivers.
    let call = 0;
    const fill = (buf: Uint32Array): void => {
      call++;
      buf.fill(call === 1 ? 4294967295 : 7);
    };
    expect(randomIntsFrom(fill)(3, 3)).toEqual([1, 1, 1]);
    expect(call).toBe(2);
  });

  it('handles the degenerate bounds', () => {
    const fill = (buf: Uint32Array): void => {
      buf.fill(123);
    };
    expect(randomIntsFrom(fill)(3, 1)).toEqual([0, 0, 0]);
    expect(randomIntsFrom(fill)(0, 10)).toEqual([]);
    expect(randomIntsFrom(fill)(2, 0)).toEqual([]);
  });

  it('the crypto-backed default stays inside [0, max)', () => {
    const values = defaultRandomInts(500, 7);
    expect(values).toHaveLength(500);
    for (const v of values) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
  });
});
