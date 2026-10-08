import { useSyncExternalStore } from 'react';

/**
 * Phone layout switch. Below this width the board becomes a single column
 * and the top bar collapses into a menu. The desktop window never gets this
 * narrow (Tauri minWidth is 800), so only the iPhone web app ever sees it.
 */
export const PHONE_QUERY = '(max-width: 700px)';

function query(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(PHONE_QUERY)
    : null;
}

function getIsPhone(): boolean {
  return query()?.matches ?? false;
}

function subscribe(listener: () => void): () => void {
  const mq = query();
  if (!mq) return () => {};
  mq.addEventListener('change', listener);
  return () => mq.removeEventListener('change', listener);
}

/** True on phone-width viewports; re-renders when the width crosses the line. */
export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribe, getIsPhone, () => false);
}

/** Mirrors the phone state onto <html data-viewport="phone"> for mobile.css. */
export function syncViewportAttribute(isPhone: boolean): void {
  const root = document.documentElement;
  if (isPhone) root.dataset.viewport = 'phone';
  else delete root.dataset.viewport;
}
