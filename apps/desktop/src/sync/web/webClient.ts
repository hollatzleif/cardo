import type { IdbStore, SyncReport } from '@cardo/sync';
import { reportSyncEvent } from '../syncStatus';
import { DriveTransport, NeedsGoogleAuth, type DriveProgress } from './driveTransport';
import { beginGoogleAuth, currentToken, forgetToken } from './googleAuth';
import { JoinDeniedError, loadConfig, RevokedError, runWebSyncRound } from './webSync';

/**
 * Runs the web app's sync in the background while the app is open: at start,
 * every 5 minutes while visible, when it becomes visible again and when the
 * network returns. iPhone web apps get no background time, so nothing syncs
 * while the app is closed. One tab syncs at a time (Web Locks).
 */

const INTERVAL_MS = 5 * 60_000;
const MIN_GAP_MS = 60_000;

export type WebSyncState =
  | { kind: 'off' }
  | { kind: 'idle'; lastSyncMs?: number }
  | { kind: 'syncing'; progress?: DriveProgress }
  | { kind: 'needs-google' }
  | { kind: 'error'; message: string }
  | { kind: 'revoked' }
  | { kind: 'join-denied' };

let store: IdbStore | null = null;
let state: WebSyncState = { kind: 'off' };
let running = false;
let lastAttemptMs = 0;
const subscribers = new Set<(s: WebSyncState) => void>();

function set(next: WebSyncState): void {
  state = next;
  subscribers.forEach((cb) => cb(state));
}

export function getWebSyncState(): WebSyncState {
  return state;
}

export function subscribeWebSync(cb: (s: WebSyncState) => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

export function isWebSyncBusy(): boolean {
  return running;
}

export function driveAuth() {
  return {
    async token(): Promise<string> {
      const token = currentToken();
      if (!token) throw new NeedsGoogleAuth();
      return token.accessToken;
    },
    invalidate: forgetToken,
  };
}

async function withLock<T>(fn: () => Promise<T>): Promise<T | null> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks) return fn();
  return locks.request('cardo-sync', { ifAvailable: true }, async (lock) => (lock ? fn() : null));
}

/** One round now (no-op if another tab or round is already syncing). */
export async function syncNow(): Promise<SyncReport | null> {
  if (!store || running) return null;
  const config = await loadConfig(store);
  if (!config?.joined) {
    set({ kind: 'off' });
    return null;
  }
  if (config.kicked) {
    set({ kind: 'revoked' });
    return null;
  }
  if (!currentToken()) {
    set({ kind: 'needs-google' });
    return null;
  }
  running = true;
  lastAttemptMs = Date.now();
  set({ kind: 'syncing' });
  try {
    const report = await withLock(() =>
      runWebSyncRound(
        store!,
        new DriveTransport(driveAuth(), (progress) => set({ kind: 'syncing', progress })),
      ),
    );
    const after = await loadConfig(store);
    set({ kind: 'idle', lastSyncMs: after?.lastSyncMs });
    if (report) reportSyncEvent({ type: 'done' });
    return report;
  } catch (e) {
    if (e instanceof NeedsGoogleAuth) {
      set({ kind: 'needs-google' });
    } else if (e instanceof RevokedError) {
      set({ kind: 'revoked' });
      reportSyncEvent({ type: 'revoked', all: e.all });
    } else if (e instanceof JoinDeniedError) {
      set({ kind: 'join-denied' });
      reportSyncEvent({ type: 'join-denied' });
    } else {
      const message = e instanceof Error ? e.message : String(e);
      set({ kind: 'error', message });
      reportSyncEvent({ type: 'error', message });
    }
    return null;
  } finally {
    running = false;
  }
}

/**
 * "Weiter mit Google": must be called straight from a tap handler (opens the
 * sign-in popup synchronously), then syncs.
 */
export function reconnectGoogle(loginHint?: string): Promise<void> {
  // No prompt=none: if Google needs a click (account chooser) the popup can
  // show it; with a granted scope and a live Google session it closes at once.
  return beginGoogleAuth({ loginHint }).then(() => void syncNow());
}

export function startWebSync(s: IdbStore): void {
  store = s;
  void syncNow();
  window.setInterval(() => {
    if (document.visibilityState === 'visible') void syncNow();
  }, INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastAttemptMs > MIN_GAP_MS)
      void syncNow();
  });
  window.addEventListener('online', () => void syncNow());
}
