import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ChangeEvent, StorageQuery } from '@cardo/plugin-api';
import { createMemoryBackend, type StorageBackend } from '@cardo/core';

export function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

/**
 * Storage backend backed by the Rust core (SQLite + change log, atomic).
 * Change events are emitted by Rust after every committed write and fanned
 * out to subscribers here.
 */
function createTauriBackend(): StorageBackend {
  const listeners = new Set<(ev: ChangeEvent) => void>();

  void listen<{ namespace: string; docId: string; operation: string }>(
    'storage:changed',
    ({ payload }) => {
      const ev: ChangeEvent = {
        namespace: payload.namespace,
        docId: payload.docId,
        operation: payload.operation as ChangeEvent['operation'],
      };
      listeners.forEach((cb) => cb(ev));
    },
  );

  return {
    get: (namespace, id) => invoke('storage_get', { namespace, id }),
    set: async (namespace, id, value) => {
      await invoke('storage_set', { namespace, id, value });
    },
    delete: async (namespace, id) => {
      await invoke('storage_delete', { namespace, id });
    },
    query: (namespace, q: StorageQuery) => invoke('storage_query', { namespace, query: q }),
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/** In the browser (pure Vite dev) we fall back to a memory backend. */
export function createBackend(): StorageBackend {
  return isTauri() ? createTauriBackend() : createMemoryBackend();
}

export interface AppInfo {
  version: string;
  platform: string;
  arch: string;
  deviceId: string;
  syncAuthorized: boolean;
}

export async function fetchAppInfo(): Promise<AppInfo> {
  if (!isTauri()) {
    return {
      version: 'dev',
      platform: 'browser',
      arch: 'wasm',
      deviceId: 'browser-dev',
      syncAuthorized: false,
    };
  }
  return invoke('app_info');
}
