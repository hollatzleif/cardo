/** Pure, unit-testable logic for the random-picker tool. */

export type RandomInts = (count: number, maxExclusive: number) => number[];

/* ── State shape ──────────────────────────────────────────────────────── */

export type PickerMode = 'wheel' | 'dice' | 'coin' | 'number' | 'yes-no' | 'shuffle' | 'pick-n';

export const PICKER_MODES: readonly PickerMode[] = [
  'wheel',
  'dice',
  'coin',
  'number',
  'yes-no',
  'shuffle',
  'pick-n',
];

export type PickerOption = { text: string; weight: number };

/** Singleton storage doc `state`: the ephemeral working set of the widget. */
export type PickerStateDoc = {
  id: string;
  type: 'state';
  options: PickerOption[];
  mode: PickerMode;
  lastResult?: string;
};

export const STATE_DOC_ID = 'state';
export const MIN_WEIGHT = 1;
export const MAX_WEIGHT = 10;

/** Legacy doc shape (pre-1.1) – only used by the one-shot migration. */
export type LegacyListDoc = {
  id: string;
  type: 'list';
  name: string;
  items: string[];
  removeOnPick: boolean;
  createdAt: string;
};

/** Clamp a weight to an integer in [MIN_WEIGHT, MAX_WEIGHT]; junk → 1. */
export function clampWeight(weight: unknown): number {
  const n = typeof weight === 'number' && Number.isFinite(weight) ? Math.round(weight) : MIN_WEIGHT;
  return Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, n));
}

/** Split textarea input into items: newline/comma separated, trimmed, empties dropped. */
export function parseItems(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Re-derive the option list after the texts were edited: options whose text
 * survives keep their weight (duplicates are matched in order), new texts
 * start at weight 1.
 */
export function mergeOptions(texts: readonly string[], previous: readonly PickerOption[]): PickerOption[] {
  const pool = [...previous];
  return texts.map((text) => {
    const at = pool.findIndex((option) => option.text === text);
    if (at === -1) return { text, weight: MIN_WEIGHT };
    const found = pool[at];
    pool.splice(at, 1);
    return { text, weight: clampWeight(found?.weight) };
  });
}

/** Options of the FIRST legacy list become the new working set (weight 1). */
export function migrateLegacyItems(lists: readonly LegacyListDoc[]): PickerOption[] {
  const first = lists[0];
  if (!first) return [];
  return first.items.map((text) => ({ text, weight: MIN_WEIGHT }));
}

/* ── Weighted picking ─────────────────────────────────────────────────── */

/**
 * Weighted pick: index i is chosen with probability weight[i] / Σweights.
 * Weights must be non-negative integers with at least one positive value;
 * anything else → null. Randomness is injected as a uniform integer source.
 */
export function weightedPickIndex(
  weights: readonly number[],
  randomInt: (maxExclusive: number) => number,
): number | null {
  if (weights.length === 0) return null;
  let total = 0;
  for (const w of weights) {
    if (!Number.isInteger(w) || w < 0) return null;
    total += w;
  }
  if (total <= 0) return null;
  const raw = Math.floor(randomInt(total));
  const target = Math.min(Math.max(0, raw), total - 1);
  let cumulative = 0;
  for (let i = 0; i < weights.length; i++) {
    cumulative += weights[i] ?? 0;
    if (target < cumulative) return i;
  }
  return weights.length - 1; // unreachable with valid inputs; defensive
}

/**
 * Draw `n` DISTINCT options, weighted without replacement (successive
 * weighted draws, removing each winner). `n` is clamped to the number of
 * positively weighted options. Invalid weights or mismatched lengths → null.
 */
export function weightedPickN<T>(
  options: readonly T[],
  weights: readonly number[],
  n: number,
  randomInts: RandomInts,
): T[] | null {
  if (options.length !== weights.length) return null;
  for (const w of weights) {
    if (!Number.isInteger(w) || w < 0) return null;
  }
  const pickable = weights.filter((w) => w > 0).length;
  const count = Math.min(Math.max(0, Math.floor(n)), pickable);
  const restOptions = [...options];
  const restWeights = [...weights];
  const picked: T[] = [];
  for (let i = 0; i < count; i++) {
    const index = weightedPickIndex(restWeights, (max) => randomInts(1, max)[0] ?? 0);
    if (index === null) break;
    const winner = restOptions[index];
    if (winner === undefined) break;
    picked.push(winner);
    restOptions.splice(index, 1);
    restWeights.splice(index, 1);
  }
  return picked;
}

/** Fisher-Yates shuffle with injected randomness; never mutates the input. */
export function shuffleAll<T>(items: readonly T[], randomInts: RandomInts): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const raw = randomInts(1, i + 1)[0] ?? 0;
    const j = Math.min(Math.max(0, Math.floor(raw)), i);
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue; // satisfies noUncheckedIndexedAccess
    out[i] = b;
    out[j] = a;
  }
  return out;
}

/* ── Simple modes ─────────────────────────────────────────────────────── */

/**
 * Uniform integer in [min, max] (inclusive, order-forgiving). Bounds are
 * snapped to integers inwards; empty or absurdly large ranges → null.
 */
export function randomInRange(
  min: number,
  max: number,
  randomInt: (maxExclusive: number) => number,
): number | null {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  if (lo > hi) return null;
  const span = hi - lo + 1;
  if (span > 0x100000000) return null; // beyond the 32-bit uniform source
  const raw = Math.floor(randomInt(span));
  return lo + Math.min(Math.max(0, raw), span - 1);
}

export type CoinSide = 'heads' | 'tails';

export function coinFlip(randomInt: (maxExclusive: number) => number): CoinSide {
  return randomInt(2) === 0 ? 'heads' : 'tails';
}

export type YesNoAnswer = 'yes' | 'no' | 'maybe';

export function yesNo(withMaybe: boolean, randomInt: (maxExclusive: number) => number): YesNoAnswer {
  const raw = Math.floor(randomInt(withMaybe ? 3 : 2));
  const n = Math.min(Math.max(0, raw), withMaybe ? 2 : 1);
  return n === 0 ? 'yes' : n === 1 ? 'no' : 'maybe';
}

/* ── Dice ─────────────────────────────────────────────────────────────── */

export const MAX_DICE_COUNT = 20;
export const MAX_DICE_SIDES = 1000;

export type DiceRoll = { count: number; sides: number; rolls: number[]; total: number };

/**
 * Parse and roll an "NdM" spec (e.g. "2d6"). Both numbers are mandatory;
 * caps: N ≤ 20, M ≤ 1000, M ≥ 2. Invalid specs → null.
 */
export function rollDice(spec: string, randomInts: RandomInts): DiceRoll | null {
  const match = /^\s*(\d{1,2})[dD](\d{1,4})\s*$/.exec(spec);
  if (!match) return null;
  const count = Number(match[1]);
  const sides = Number(match[2]);
  if (count < 1 || count > MAX_DICE_COUNT || sides < 2 || sides > MAX_DICE_SIDES) return null;
  const rolls = randomInts(count, sides).map((v) => v + 1);
  if (rolls.length !== count) return null;
  return { count, sides, rolls, total: rolls.reduce((sum, v) => sum + v, 0) };
}

/* ── Assistant context ────────────────────────────────────────────────── */

/** Assistant context: current mode, the working options (with weights) and the last result. */
export function buildPickerContext(state: PickerStateDoc | null, language: string): string {
  const de = language === 'de';
  if (!state || state.options.length === 0) {
    const head = de
      ? 'Zufallsentscheider: keine Optionen eingetragen.'
      : 'Random picker: no options entered.';
    const mode = state ? (de ? ` Modus: ${state.mode}.` : ` Mode: ${state.mode}.`) : '';
    return head + mode;
  }
  const preview = state.options
    .slice(0, 12)
    .map((option) => (option.weight === 1 ? option.text : `${option.text} (×${option.weight})`))
    .join(', ');
  const more = state.options.length > 12 ? ' …' : '';
  const lines = [
    de
      ? `Zufallsentscheider – Modus: ${state.mode}, ${state.options.length} Option(en):`
      : `Random picker – mode: ${state.mode}, ${state.options.length} option(s):`,
    `– ${preview}${more}`,
  ];
  if (state.lastResult) {
    lines.push(de ? `Letztes Ergebnis: ${state.lastResult}` : `Last result: ${state.lastResult}`);
  }
  return lines.join('\n');
}

/* ── Runtime randomness (rejection sampling – no modulo bias) ─────────── */

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

/** Cryptographically secure default source. */
export const defaultRandomInts: RandomInts = randomIntsFrom((buf) => {
  crypto.getRandomValues(buf);
});

/** One secure uniform integer in [0, maxExclusive). */
export function secureRandomInt(maxExclusive: number): number {
  return defaultRandomInts(1, maxExclusive)[0] ?? 0;
}
