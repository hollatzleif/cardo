import i18next from 'i18next';
import type { Host } from '../host';

/**
 * Service worker registration and the update flow of the web app. A new
 * version is downloaded in the background but only takes over after the
 * user taps "Neu laden" in a toast – never in the middle of a sync.
 */

let waiting: ServiceWorker | null = null;
let syncBusy: () => boolean = () => false;

export function setSyncBusyProbe(probe: () => boolean): void {
  syncBusy = probe;
}

function offerReload(host: Host, worker: ServiceWorker): void {
  waiting = worker;
  host.services.events.emit('core:toast', {
    title: i18next.t('web.update.available'),
    actionLabel: i18next.t('web.update.reload'),
    onAction: () => applyUpdate(),
  } as never);
}

export function applyUpdate(): void {
  const worker = waiting;
  if (!worker) return;
  const go = () => {
    if (syncBusy()) {
      window.setTimeout(go, 500);
      return;
    }
    worker.postMessage({ type: 'SKIP_WAITING' });
  };
  go();
}

export async function registerServiceWorker(host: Host): Promise<void> {
  // Only the production build ships sw.js (vite dev serves no worker).
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
  try {
    const registration = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
      scope: import.meta.env.BASE_URL,
    });
    const watch = (worker: ServiceWorker | null) => {
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) offerReload(host, worker);
      });
    };
    if (registration.waiting && navigator.serviceWorker.controller) offerReload(host, registration.waiting);
    registration.addEventListener('updatefound', () => watch(registration.installing));
    const check = () => void registration.update().catch(() => {});
    window.setInterval(check, 60 * 60_000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
  } catch {
    // No service worker (private mode, unsupported): the app still works online.
  }
}

/** Asks the browser not to evict our storage (best effort, iOS may ignore). */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
