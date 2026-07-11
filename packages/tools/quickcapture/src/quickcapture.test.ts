import { describe, expect, it } from 'vitest';
import { isCapturable, ITEM_PREFIX, makeItem, sortItems, type ItemDoc } from './logic';

describe('quickcapture logic', () => {
  it('makeItem trims text and stores its own id inside the doc', () => {
    const item = makeItem('  buy milk  ', new Date('2026-07-11T10:00:00.000Z'));
    expect(item.text).toBe('buy milk');
    expect(item.type).toBe('item');
    expect(item.id.startsWith(ITEM_PREFIX)).toBe(true);
    expect(item.createdAt).toBe('2026-07-11T10:00:00.000Z');
  });

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => makeItem('x').id));
    expect(ids.size).toBe(50);
  });

  it('sortItems orders newest first without mutating the input', () => {
    const older: ItemDoc = { id: 'item:a', type: 'item', text: 'old', createdAt: '2026-01-01T00:00:00.000Z' };
    const newer: ItemDoc = { id: 'item:b', type: 'item', text: 'new', createdAt: '2026-06-01T00:00:00.000Z' };
    const input = [older, newer];
    const sorted = sortItems(input);
    expect(sorted.map((i) => i.id)).toEqual(['item:b', 'item:a']);
    expect(input[0]).toBe(older);
  });

  it('sortItems breaks createdAt ties by id for stable order', () => {
    const a: ItemDoc = { id: 'item:a', type: 'item', text: 'a', createdAt: '2026-01-01T00:00:00.000Z' };
    const b: ItemDoc = { id: 'item:b', type: 'item', text: 'b', createdAt: '2026-01-01T00:00:00.000Z' };
    expect(sortItems([b, a]).map((i) => i.id)).toEqual(['item:a', 'item:b']);
  });

  it('isCapturable rejects blank input', () => {
    expect(isCapturable('')).toBe(false);
    expect(isCapturable('   ')).toBe(false);
    expect(isCapturable(' idea ')).toBe(true);
  });
});
