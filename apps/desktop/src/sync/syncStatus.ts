/**
 * Listener for the background sync lane.
 *
 * Rust emits `sync:error`, `sync:done`, `sync:revoked` and `sync:join-denied`
 * from five places in sync.rs — and until now NOTHING in the webview listened
 * to any of them. The 5-minute background loop could fail on every single
 * round for days while the UI stayed green and the assistant reported "no key
 * configured". That is the "sync suddenly stopped working" failure, discovered
 * only when a demo needed it.
 *
 * This module is the missing ear: it records what the sync lane reports and
 * hands it to the settings UI, the diagnose panel and the assistant.
 */
import { listen } from '@tauri-apps/api/event';
import { isTauri } from '../host/backend';

export type SyncHealth = 'unknown' | 'ok' | 'error' | 'revoked' | 'join-denied';

export interface SyncStatus {
  health: SyncHealth;
  /** Raw message from Rust – shown verbatim so no detail is lost. */
  message?: string;
  /** When the last event of any kind arrived. */
  atMs?: number;
  /** Last successful round, regardless of what happened after. */
  lastSuccessMs?: number;
  /** Consecutive failures since the last success — one bad round is noise. */
  consecutiveErrors: number;
}

const INITIAL: SyncStatus = { health: 'unknown', consecutiveErrors: 0 };

let status: SyncStatus = INITIAL;
const subscribers = new Set<(s: SyncStatus) => void>();
let started = false;

function update(next: Partial<SyncStatus>): void {
  status = { ...status, ...next, atMs: Date.now() };
  subscribers.forEach((cb) => cb(status));
}

export function getSyncStatus(): SyncStatus {
  return status;
}

export function subscribeSyncStatus(cb: (s: SyncStatus) => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

/** Test seam – resets module state between suites. */
export function resetSyncStatus(): void {
  status = INITIAL;
  subscribers.clear();
  started = false;
}

/**
 * Starts listening. Idempotent, and a no-op outside Tauri (browser dev has no
 * event bridge). Call once during app startup.
 */
export function initSyncStatus(): void {
  if (started || !isTauri()) return;
  started = true;

  void listen<string>('sync:error', ({ payload }) => {
    update({
      health: 'error',
      message: String(payload),
      consecutiveErrors: status.consecutiveErrors + 1,
    });
  });

  void listen('sync:done', () => {
    const now = Date.now();
    update({ health: 'ok', message: undefined, lastSuccessMs: now, consecutiveErrors: 0 });
  });

  void listen<boolean>('sync:revoked', ({ payload }) => {
    update({ health: 'revoked', message: payload ? 'group dissolved' : 'device removed' });
  });

  void listen('sync:join-denied', () => {
    update({ health: 'join-denied', message: 'join request denied' });
  });
}
