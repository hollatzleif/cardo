import { describe, expect, it } from 'vitest';
import { advance, LOOKBACK_MS, parseCursor, renderCursor, selectNames } from './lookback';

const name = (ms: number, id: string) => `${String(ms).padStart(13, '0')}-${id}.cardo-ops`;

describe('lookback cursor', () => {
  it('reads everything once from scratch', () => {
    const names = [name(1000, 'a'), name(2000, 'b')];
    let c = parseCursor('');
    const first = selectNames(names, c, 50);
    expect(first).toEqual(names);
    c = advance(c, first);
    expect(selectNames(names, c, 50)).toEqual([]);
  });

  it('still reads a late file named before the cursor, exactly once', () => {
    const t = 1_700_000_000_000;
    let c = advance(parseCursor(''), [name(t, 'b')]);
    const late = name(t - 5000, 'late');
    expect(selectNames([late, name(t, 'b')], c, 50)).toEqual([late]);
    c = advance(c, [late]);
    expect(selectNames([late, name(t, 'b')], c, 50)).toEqual([]);
    expect(c.last).toBe(name(t, 'b'));
  });

  it('ignores files older than the window and trims seen', () => {
    const t = 1_700_000_000_000;
    const c = advance(parseCursor(''), [name(t - LOOKBACK_MS - 1, 'old'), name(t, 'new')]);
    expect(c.seen).toEqual([name(t, 'new')]);
    expect(selectNames([name(t - LOOKBACK_MS - 5, 'ancient')], c, 50)).toEqual([]);
  });

  it('migrates a plain-name cursor and round-trips', () => {
    const c = parseCursor(name(5, 'x'));
    expect(c).toEqual({ last: name(5, 'x'), seen: [] });
    expect(parseCursor(renderCursor({ last: 'a', seen: ['c', 'b'] }))).toEqual({
      last: 'a',
      seen: ['b', 'c'],
    });
  });

  it('respects take', () => {
    const names = Array.from({ length: 5 }, (_, i) => name(1000 + i, String(i)));
    expect(selectNames(names, parseCursor(''), 2)).toEqual(names.slice(0, 2));
  });
});
