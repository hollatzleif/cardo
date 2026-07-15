/** Pure, unit-testable logic for the random-picker tool. */

export type RandomInts = (count: number, maxExclusive: number) => number[];

export type PickerListDoc = {
  id: string;
  type: 'list';
  name: string;
  items: string[];
  removeOnPick: boolean;
  createdAt: string;
};

/** Uniform pick over `length` items; randomness is injected. Null when empty. */
export function pickIndex(length: number, randomInt: (maxExclusive: number) => number): number | null {
  if (!Number.isInteger(length) || length <= 0) return null;
  const raw = Math.floor(randomInt(length));
  return Math.min(Math.max(0, raw), length - 1);
}

/** Copy of `items` without index `index`; out-of-range indices are a no-op. */
export function removeAt<T>(items: readonly T[], index: number): T[] {
  if (!Number.isInteger(index) || index < 0 || index >= items.length) return [...items];
  return items.filter((_, i) => i !== index);
}

/** Split textarea input into items: newline/comma separated, trimmed, empties dropped. */
export function parseItems(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

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

/** Assistant context: what lists exist and how many options each holds. */
export function buildPickerContext(lists: readonly PickerListDoc[], language: string): string {
  const de = language === 'de';
  if (lists.length === 0) {
    return de ? 'Zufallsentscheider: keine Listen vorhanden.' : 'Random picker: no lists yet.';
  }
  const lines = lists.slice(0, 10).map((list) => {
    const preview = list.items.slice(0, 8).join(', ');
    const more = list.items.length > 8 ? ' …' : '';
    const consume = list.removeOnPick
      ? de
        ? ', Einträge werden nach dem Ziehen entfernt'
        : ', entries are removed once picked'
      : '';
    return de
      ? `– «${list.name}» (${list.items.length} Einträge${consume}): ${preview}${more}`
      : `– «${list.name}» (${list.items.length} entries${consume}): ${preview}${more}`;
  });
  const head = de
    ? `Zufallsentscheider – ${lists.length} Liste(n):`
    : `Random picker – ${lists.length} list(s):`;
  return [head, ...lines].join('\n');
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
