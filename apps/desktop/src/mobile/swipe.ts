/**
 * Horizontal swipe between dashboard pages on the phone. Pure decision
 * function (tested) + a tiny hook-free binder used by Canvas.
 */

export const SWIPE_MIN_DX = 70;
export const SWIPE_MAX_DY = 45;
export const SWIPE_MAX_MS = 600;

/** -1 = previous page, 1 = next page, 0 = not a page swipe. */
export function swipeDirection(dx: number, dy: number, ms: number): -1 | 0 | 1 {
  if (ms > SWIPE_MAX_MS || Math.abs(dy) > SWIPE_MAX_DY || Math.abs(dx) < SWIPE_MIN_DX) return 0;
  return dx < 0 ? 1 : -1;
}

/** Gestures that start in controls with their own horizontal meaning are not page swipes. */
export function swipeAllowedFrom(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  return !target.closest(
    'input, textarea, select, [contenteditable="true"], [role="slider"], .mobile-sheet, .c-modal, [data-no-page-swipe]',
  );
}
