import type { WidgetInstance } from '../state/appStore';

/**
 * Pure helpers for the single-column phone board. The phone keeps the same
 * x/y/w/h model as the desktop grid (layouts are stored per device and are
 * not synced by default), it just reads it as a reading order.
 */

/** Reading order of a grid: top to bottom, then left to right. */
export function phoneOrder(widgets: readonly WidgetInstance[]): WidgetInstance[] {
  return [...widgets].sort(
    (a, b) => a.y - b.y || a.x - b.x || a.instanceId.localeCompare(b.instanceId),
  );
}

export const PHONE_MAX_ROWS = 16;
/** Rows a card is at least tall by default on the phone (content may make it taller). */
export const PHONE_MIN_ROWS_CAP = 4;

/** Card height in px for `h` grid rows at the given row height and gutter. */
export function phoneCardHeight(
  h: number,
  rowHeight: number,
  gutter: number,
  minH: number,
): number {
  const rows = Math.max(minH, Math.min(PHONE_MAX_ROWS, h));
  return rows * rowHeight + (rows - 1) * gutter;
}

/**
 * Width in grid columns a widget is told it has on a phone. A ~390 px screen
 * is about as wide as four desktop columns, so widgets pick their compact
 * layout – but never narrower than their declared minimum.
 */
export function phoneWidgetCols(minW: number): number {
  return Math.max(4, Math.min(12, minW));
}

export interface PositionUpdate {
  instanceId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Moves a widget one step up (-1) or down (+1) in the phone order by
 * swapping its grid position with the neighbour's. Returns the two position
 * updates, or [] at the ends of the list.
 */
export function moveInPhoneOrder(
  widgets: readonly WidgetInstance[],
  instanceId: string,
  direction: -1 | 1,
): PositionUpdate[] {
  const ordered = phoneOrder(widgets);
  const index = ordered.findIndex((w) => w.instanceId === instanceId);
  const other = ordered[index + direction];
  if (index < 0 || !other) return [];
  const self = ordered[index]!;
  if (self.x === other.x && self.y === other.y) {
    // Same cell (can happen after imports): nudge so the order really flips.
    const y = direction < 0 ? other.y - 1 : other.y + 1;
    return [{ instanceId: self.instanceId, x: self.x, y: Math.max(0, y), w: self.w, h: self.h }];
  }
  return [
    { instanceId: self.instanceId, x: other.x, y: other.y, w: self.w, h: self.h },
    { instanceId: other.instanceId, x: self.x, y: self.y, w: other.w, h: other.h },
  ];
}

/** Grows (+1) or shrinks (-1) a widget's height within [minH, PHONE_MAX_ROWS]. */
export function resizeInPhone(
  widget: WidgetInstance,
  delta: -1 | 1,
  minH: number,
): PositionUpdate | null {
  const h = Math.max(minH, Math.min(PHONE_MAX_ROWS, widget.h + delta));
  if (h === widget.h) return null;
  return { instanceId: widget.instanceId, x: widget.x, y: widget.y, w: widget.w, h };
}
