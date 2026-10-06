import { describe, expect, it } from 'vitest';
import type { WidgetInstance } from '../state/appStore';
import { moveInPhoneOrder, phoneCardHeight, phoneOrder, phoneWidgetCols, resizeInPhone } from './mobileLayout';

const w = (id: string, x: number, y: number, h = 3): WidgetInstance =>
  ({ instanceId: id, toolId: 't', widgetId: 'main', x, y, w: 4, h }) as WidgetInstance;

describe('phone layout helpers', () => {
  it('orders top-to-bottom, then left-to-right', () => {
    const order = phoneOrder([w('c', 8, 0), w('a', 0, 0), w('d', 0, 7), w('b', 4, 0)]);
    expect(order.map((x) => x.instanceId)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('computes card height from rows and gutter, clamped', () => {
    expect(phoneCardHeight(3, 56, 12, 2)).toBe(3 * 56 + 2 * 12);
    expect(phoneCardHeight(1, 56, 12, 2)).toBe(2 * 56 + 12);
    expect(phoneCardHeight(40, 56, 0, 1)).toBe(16 * 56);
  });

  it('tells widgets they are about four columns wide, respecting minW', () => {
    expect(phoneWidgetCols(2)).toBe(4);
    expect(phoneWidgetCols(6)).toBe(6);
  });

  it('moves by swapping grid positions with the neighbour', () => {
    const list = [w('a', 0, 0), w('b', 4, 0), w('c', 0, 5)];
    expect(moveInPhoneOrder(list, 'b', 1)).toEqual([
      { instanceId: 'b', x: 0, y: 5, w: 4, h: 3 },
      { instanceId: 'c', x: 4, y: 0, w: 4, h: 3 },
    ]);
    expect(moveInPhoneOrder(list, 'a', -1)).toEqual([]);
    expect(moveInPhoneOrder(list, 'c', 1)).toEqual([]);
  });

  it('resizes within bounds', () => {
    expect(resizeInPhone(w('a', 0, 0, 3), 1, 2)?.h).toBe(4);
    expect(resizeInPhone(w('a', 0, 0, 2), -1, 2)).toBeNull();
    expect(resizeInPhone(w('a', 0, 0, 16), 1, 2)).toBeNull();
  });
});
