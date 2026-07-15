/**
 * Pure, storage-free logic for the Sticky Notes tool.
 * Kept separate from index.tsx so it can be unit-tested in a plain node
 * environment (no React, no DOM, no host).
 */

/** Sticky note colors are semantic chart tokens – never raw colors. */
export type ColorToken =
  | 'chart-1'
  | 'chart-2'
  | 'chart-3'
  | 'chart-4'
  | 'chart-5'
  | 'chart-6'
  | 'chart-7'
  | 'chart-8';

export const COLOR_TOKENS: ColorToken[] = [
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'chart-6',
  'chart-7',
  'chart-8',
];

export type NoteDoc = {
  /**
   * Stable id, identical to the storage doc id. query() returns doc bodies
   * WITHOUT their ids, so the id always lives inside the doc as well.
   */
  id: string;
  type: 'note';
  text: string;
  colorToken: ColorToken;
  /** Position as PERCENT (0–100) of the widget, so the layout scales. */
  x: number;
  y: number;
  /** Stacking order – higher is in front. */
  z: number;
  createdAt: string;
};

export function makeId(): string {
  return `note:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Clamp a percent coordinate pair into the 0–100 canvas; non-finite → 0. */
export function clampPosition(x: number, y: number): { x: number; y: number } {
  const clamp = (value: number): number =>
    Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
  return { x: clamp(x), y: clamp(y) };
}

/** Highest z among the notes; 0 for an empty wall. */
export function maxZ(notes: Array<Pick<NoteDoc, 'z'>>): number {
  return notes.reduce((top, note) => Math.max(top, note.z), 0);
}

/**
 * z-order for bringing a note to the front. STABLE: a note that is already
 * the sole top note keeps its z (no storage write); everything else gets
 * maxZ + 1. Unknown ids also get maxZ + 1 (caller decides whether to write).
 */
export function bringToFront(notes: Array<Pick<NoteDoc, 'id' | 'z'>>, id: string): number {
  const top = maxZ(notes);
  const note = notes.find((n) => n.id === id);
  if (note && note.z === top && notes.every((n) => n.id === id || n.z < top)) {
    return note.z;
  }
  return top + 1;
}

function colorIndex(token: ColorToken): number {
  return COLOR_TOKENS.indexOf(token);
}

/**
 * Rotating default color: one step after the most recently created note's
 * color, wrapping chart-8 → chart-1. First note gets chart-1.
 */
export function nextColor(notes: Array<Pick<NoteDoc, 'colorToken' | 'createdAt'>>): ColorToken {
  if (notes.length === 0) return 'chart-1';
  const newest = [...notes].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
  )[0];
  if (!newest) return 'chart-1';
  const index = colorIndex(newest.colorToken);
  const next = COLOR_TOKENS[(index + 1) % COLOR_TOKENS.length];
  return next ?? 'chart-1';
}

/**
 * Build a new note. Defaults: rotating color, cascading position (so stacked
 * new notes never fully cover each other) and z on top of everything.
 */
export function makeNote(
  input: { text: string; colorToken?: ColorToken; x?: number; y?: number },
  notes: NoteDoc[],
  now: Date = new Date(),
): NoteDoc {
  const cascade = (notes.length % 5) * 10;
  const { x, y } = clampPosition(input.x ?? 6 + cascade, input.y ?? 6 + cascade);
  return {
    id: makeId(),
    type: 'note',
    text: input.text.trim(),
    colorToken: input.colorToken ?? nextColor(notes),
    x,
    y,
    z: maxZ(notes) + 1,
    createdAt: now.toISOString(),
  };
}

/** Grid variant order: oldest first, id as deterministic tiebreaker. */
export function sortForGrid(notes: NoteDoc[]): NoteDoc[] {
  return [...notes].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Compact snapshot of the wall for the assistant's "current state" context,
 * so it can reference or deduplicate notes. Newest first, capped for prompt size.
 */
export function buildStickyContext(notes: NoteDoc[], language: string): string {
  const de = language === 'de';
  if (notes.length === 0) {
    return de ? 'Keine Notizen an der Wand.' : 'No sticky notes on the wall.';
  }
  const newestFirst = sortForGrid(notes).reverse();
  const labels = newestFirst.slice(0, 15).map((note) => {
    const text = note.text.length > 60 ? `${note.text.slice(0, 59)}…` : note.text;
    return `«${text}»`;
  });
  const heading = de
    ? `${notes.length} Notiz${notes.length === 1 ? '' : 'en'} (neueste zuerst)`
    : `${notes.length} sticky note${notes.length === 1 ? '' : 's'} (newest first)`;
  return `${heading}: ${labels.join(', ')}.`;
}
