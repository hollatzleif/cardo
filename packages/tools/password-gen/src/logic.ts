/** Pure, unit-testable logic for the password-gen tool. Nothing here persists anything. */

export type RandomInts = (count: number, maxExclusive: number) => number[];

export type CharsetOptions = {
  lower: boolean;
  upper: boolean;
  digits: boolean;
  symbols: boolean;
  /** Drop the easily confused characters O 0 I l 1 |. */
  excludeAmbiguous: boolean;
};

export type PasswordOptions = CharsetOptions & { length: number };

export const MIN_LENGTH = 8;
export const MAX_LENGTH = 128;

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const SYMBOLS = '!$%&()*+-./:;<=>?@[]^_{}~|';
const AMBIGUOUS = new Set(['O', '0', 'I', 'l', '1', '|']);

export const DEFAULT_OPTIONS: PasswordOptions = {
  length: 16,
  lower: true,
  upper: true,
  digits: true,
  symbols: true,
  excludeAmbiguous: false,
};

/** The enabled character classes, ambiguity-filtered; empty when nothing is enabled. */
export function buildCharset(opts: CharsetOptions): string[] {
  const strip = (chars: string): string =>
    opts.excludeAmbiguous ? [...chars].filter((c) => !AMBIGUOUS.has(c)).join('') : chars;
  const classes: string[] = [];
  if (opts.lower) classes.push(strip(LOWER));
  if (opts.upper) classes.push(strip(UPPER));
  if (opts.digits) classes.push(strip(DIGITS));
  if (opts.symbols) classes.push(strip(SYMBOLS));
  return classes.filter((c) => c.length > 0);
}

export function clampLength(length: number): number {
  if (!Number.isFinite(length)) return DEFAULT_OPTIONS.length;
  return Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, Math.round(length)));
}

/**
 * Generate a password. Randomness is injected (`randomInts`) so tests are
 * deterministic; at least one character of every enabled class is guaranteed.
 * Returns null when no character class is enabled.
 */
export function generatePassword(opts: PasswordOptions, randomInts: RandomInts): string | null {
  const classes = buildCharset(opts);
  if (classes.length === 0) return null;
  const pool = classes.join('');
  const length = clampLength(opts.length);

  const chars = randomInts(length, pool.length).map((i) => pool[i] ?? pool[0] ?? '');

  // Guarantee one character of each enabled class at distinct positions.
  const freePositions = Array.from({ length }, (_, i) => i);
  for (const cls of classes) {
    const slot = randomInts(1, freePositions.length)[0] ?? 0;
    const position = freePositions.splice(slot, 1)[0] ?? 0;
    chars[position] = cls[randomInts(1, cls.length)[0] ?? 0] ?? cls[0] ?? '';
  }
  return chars.join('');
}

/** Entropy of a random password with these options, in bits. */
export function entropyBits(opts: PasswordOptions): number {
  const poolSize = buildCharset(opts).join('').length;
  if (poolSize === 0) return 0;
  return clampLength(opts.length) * Math.log2(poolSize);
}

export type StrengthLabel = 'weak' | 'ok' | 'strong' | 'excellent';

export function strengthLabel(bits: number): StrengthLabel {
  if (bits < 50) return 'weak';
  if (bits < 80) return 'ok';
  if (bits < 110) return 'strong';
  return 'excellent';
}

/* ── Passphrases ──────────────────────────────────────────────────────── */

export const MIN_WORDS = 3;
export const MAX_WORDS = 12;

/** Embedded diceware-style wordlist: 200 short, common English words. */
export const WORDLIST: readonly string[] = [
  'acid', 'acorn', 'actor', 'alarm', 'album', 'alien', 'amber', 'anchor', 'angle', 'ankle',
  'apple', 'apron', 'arrow', 'atlas', 'attic', 'axis', 'bacon', 'badge', 'bagel', 'banjo',
  'barn', 'basil', 'beach', 'bean', 'bear', 'beard', 'bell', 'bench', 'berry', 'bird',
  'blade', 'blank', 'blaze', 'bloom', 'board', 'boat', 'bonus', 'book', 'boot', 'bottle',
  'brave', 'bread', 'brick', 'bride', 'broom', 'brush', 'bunny', 'cabin', 'cable', 'cactus',
  'cake', 'camel', 'candle', 'canoe', 'cargo', 'carpet', 'castle', 'cedar', 'chair', 'chalk',
  'cheese', 'cherry', 'chess', 'chief', 'chill', 'choir', 'cider', 'circle', 'claw', 'clay',
  'cliff', 'cloak', 'clock', 'cloud', 'clover', 'coast', 'cobra', 'cocoa', 'comet', 'coral',
  'couch', 'cousin', 'crane', 'crate', 'crayon', 'cream', 'creek', 'crown', 'cube', 'daisy',
  'dance', 'deer', 'delta', 'denim', 'diary', 'dice', 'dove', 'dragon', 'drum', 'dune',
  'dusk', 'eagle', 'earth', 'easel', 'echo', 'elbow', 'elder', 'ember', 'engine', 'fable',
  'falcon', 'feast', 'fence', 'fern', 'ferry', 'fiddle', 'field', 'flame', 'flask', 'fleet',
  'flint', 'flute', 'forest', 'fox', 'frost', 'fruit', 'garden', 'gecko', 'giant', 'ginger',
  'glacier', 'globe', 'glove', 'goose', 'grape', 'grove', 'guitar', 'harbor', 'hawk', 'hazel',
  'heron', 'hill', 'honey', 'horse', 'house', 'igloo', 'iris', 'island', 'ivory', 'jacket',
  'jaguar', 'jelly', 'jewel', 'jungle', 'kayak', 'kettle', 'kiosk', 'kite', 'koala', 'ladder',
  'lagoon', 'lantern', 'leaf', 'lemon', 'lily', 'lion', 'lizard', 'llama', 'lobster', 'lotus',
  'lunar', 'magnet', 'mango', 'maple', 'marble', 'meadow', 'melon', 'mint', 'mirror', 'moose',
  'moss', 'moth', 'mountain', 'mule', 'mural', 'nest', 'noble', 'north', 'nutmeg', 'oasis',
  'ocean', 'olive', 'onion', 'opera', 'orbit', 'otter', 'owl', 'panda', 'paper', 'pearl',
];

function clampWords(wordCount: number): number {
  if (!Number.isFinite(wordCount)) return 5;
  return Math.min(MAX_WORDS, Math.max(MIN_WORDS, Math.round(wordCount)));
}

/**
 * Generate a passphrase of `wordCount` words from the embedded wordlist,
 * joined by `separator`. Randomness is injected for deterministic tests.
 */
export function generatePassphrase(
  wordCount: number,
  separator: string,
  randomInts: RandomInts,
): string {
  const count = clampWords(wordCount);
  return randomInts(count, WORDLIST.length)
    .map((i) => WORDLIST[i] ?? WORDLIST[0] ?? '')
    .join(separator);
}

export function passphraseEntropyBits(wordCount: number): number {
  return clampWords(wordCount) * Math.log2(WORDLIST.length);
}

/* ── Runtime randomness (rejection sampling – no modulo bias) ─────────── */

/**
 * Build a `RandomInts` source from a raw 32-bit filler. Values ≥ the largest
 * multiple of `maxExclusive` below 2³² are rejected and redrawn, so every
 * result in [0, maxExclusive) is exactly equally likely.
 */
export function randomIntsFrom(fill: (buf: Uint32Array) => void): RandomInts {
  return (count, maxExclusive) => {
    const out: number[] = [];
    if (count <= 0 || maxExclusive <= 0) return out;
    if (maxExclusive === 1) return new Array<number>(count).fill(0);
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    const buf = new Uint32Array(64);
    while (out.length < count) {
      fill(buf);
      for (const value of buf) {
        if (value >= limit) continue; // rejection sampling
        out.push(value % maxExclusive);
        if (out.length === count) break;
      }
    }
    return out;
  };
}

/** Cryptographically secure default source (used by the widget and command). */
export const defaultRandomInts: RandomInts = randomIntsFrom((buf) => {
  crypto.getRandomValues(buf);
});
