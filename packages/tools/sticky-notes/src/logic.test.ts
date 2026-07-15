import { describe, expect, it } from 'vitest';
import {
  bringToFront,
  buildStickyContext,
  clampPosition,
  makeId,
  makeNote,
  maxZ,
  nextColor,
  sortForGrid,
  type NoteDoc,
} from './logic';

function note(overrides: Partial<NoteDoc>): NoteDoc {
  return {
    id: 'note:base',
    type: 'note',
    text: 'hello',
    colorToken: 'chart-1',
    x: 10,
    y: 10,
    z: 1,
    createdAt: '2026-07-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('makeId', () => {
  it('is prefixed and unique', () => {
    const ids = new Set(Array.from({ length: 100 }, () => makeId()));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id.startsWith('note:')).toBe(true);
  });
});

describe('clampPosition', () => {
  it('passes values inside the canvas through', () => {
    expect(clampPosition(0, 100)).toEqual({ x: 0, y: 100 });
    expect(clampPosition(42.5, 7)).toEqual({ x: 42.5, y: 7 });
  });

  it('clamps values outside the 0–100 canvas', () => {
    expect(clampPosition(-5, 105)).toEqual({ x: 0, y: 100 });
    expect(clampPosition(1000, -1000)).toEqual({ x: 100, y: 0 });
  });

  it('treats non-finite input as 0', () => {
    expect(clampPosition(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({ x: 0, y: 0 });
  });
});

describe('maxZ / bringToFront', () => {
  const wall = [
    note({ id: 'note:a', z: 1 }),
    note({ id: 'note:b', z: 5 }),
    note({ id: 'note:c', z: 3 }),
  ];

  it('maxZ finds the top note and is 0 for an empty wall', () => {
    expect(maxZ(wall)).toBe(5);
    expect(maxZ([])).toBe(0);
  });

  it('raises a buried note above the current top', () => {
    expect(bringToFront(wall, 'note:a')).toBe(6);
    expect(bringToFront(wall, 'note:c')).toBe(6);
  });

  it('is stable: the sole top note keeps its z', () => {
    expect(bringToFront(wall, 'note:b')).toBe(5);
  });

  it('breaks z ties by assigning a fresh top z', () => {
    const tied = [note({ id: 'note:a', z: 5 }), note({ id: 'note:b', z: 5 })];
    expect(bringToFront(tied, 'note:a')).toBe(6);
  });

  it('handles unknown ids and the first note', () => {
    expect(bringToFront(wall, 'note:ghost')).toBe(6);
    expect(bringToFront([], 'note:first')).toBe(1);
  });
});

describe('nextColor', () => {
  it('starts the rotation at chart-1', () => {
    expect(nextColor([])).toBe('chart-1');
  });

  it('advances one step after the most recently created note', () => {
    const notes = [
      note({ id: 'note:old', colorToken: 'chart-7', createdAt: '2026-01-01T00:00:00.000Z' }),
      note({ id: 'note:new', colorToken: 'chart-3', createdAt: '2026-06-01T00:00:00.000Z' }),
    ];
    expect(nextColor(notes)).toBe('chart-4');
  });

  it('wraps chart-8 back to chart-1', () => {
    expect(nextColor([note({ colorToken: 'chart-8' })])).toBe('chart-1');
  });
});

describe('makeNote', () => {
  it('trims text and stacks on top with a rotating color', () => {
    const existing = [note({ id: 'note:a', z: 4, colorToken: 'chart-2' })];
    const fresh = makeNote({ text: '  buy milk  ' }, existing, new Date('2026-07-02T08:00:00Z'));
    expect(fresh.id.startsWith('note:')).toBe(true);
    expect(fresh.type).toBe('note');
    expect(fresh.text).toBe('buy milk');
    expect(fresh.z).toBe(5);
    expect(fresh.colorToken).toBe('chart-3');
    expect(fresh.createdAt).toBe('2026-07-02T08:00:00.000Z');
  });

  it('respects explicit color and clamps explicit positions', () => {
    const fresh = makeNote({ text: 'x', colorToken: 'chart-6', x: 250, y: -3 }, []);
    expect(fresh.colorToken).toBe('chart-6');
    expect(fresh.x).toBe(100);
    expect(fresh.y).toBe(0);
  });

  it('cascades default positions so stacked notes stay visible', () => {
    const first = makeNote({ text: 'a' }, []);
    expect(first.x).toBe(6);
    expect(first.y).toBe(6);
    const third = makeNote({ text: 'c' }, [note({ id: 'note:1' }), note({ id: 'note:2' })]);
    expect(third.x).toBe(26);
    expect(third.y).toBe(26);
  });
});

describe('sortForGrid', () => {
  it('orders oldest first with the id as tiebreaker', () => {
    const a = note({ id: 'note:a', createdAt: '2026-03-01T00:00:00.000Z' });
    const b = note({ id: 'note:b', createdAt: '2026-01-01T00:00:00.000Z' });
    const c = note({ id: 'note:c', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(sortForGrid([a, c, b]).map((n) => n.id)).toEqual(['note:b', 'note:c', 'note:a']);
  });
});

describe('buildStickyContext', () => {
  it('reports an empty wall in both languages', () => {
    expect(buildStickyContext([], 'en')).toBe('No sticky notes on the wall.');
    expect(buildStickyContext([], 'de')).toBe('Keine Notizen an der Wand.');
  });

  it('lists notes newest first with a count', () => {
    const text = buildStickyContext(
      [
        note({ id: 'note:a', text: 'older', createdAt: '2026-01-01T00:00:00.000Z' }),
        note({ id: 'note:b', text: 'newer', createdAt: '2026-06-01T00:00:00.000Z' }),
      ],
      'en',
    );
    expect(text).toBe('2 sticky notes (newest first): «newer», «older».');
  });

  it('uses German singular/plural forms', () => {
    expect(buildStickyContext([note({ text: 'eine' })], 'de')).toContain('1 Notiz (neueste zuerst)');
    expect(
      buildStickyContext([note({ id: 'note:a' }), note({ id: 'note:b' })], 'de'),
    ).toContain('2 Notizen');
  });

  it('truncates long note texts and caps the listing at 15', () => {
    const long = note({ text: 'x'.repeat(80) });
    expect(buildStickyContext([long], 'en')).toContain(`«${'x'.repeat(59)}…»`);
    const many = Array.from({ length: 20 }, (_, i) =>
      note({ id: `note:${i}`, text: `n${i}`, createdAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` }),
    );
    const text = buildStickyContext(many, 'en');
    expect(text).toContain('«n19»');
    expect(text).toContain('«n5»');
    expect(text).not.toContain('«n4»');
  });
});
