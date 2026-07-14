import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './backend';
import { open } from '@tauri-apps/plugin-dialog';
import type { FilesApi } from '@cardo/plugin-api';

/**
 * FilesApi backed by the Rust notes commands. The webview only ever sends
 * file NAMES; Rust resolves and validates them inside the configured folder.
 */
/** In-memory FilesApi for browser dev – notes stay usable, nothing persists. */
function createMemoryFilesApi(): FilesApi {
  const files = new Map<string, string>();
  return {
    pickFolder: async () => '/memory',
    getFolder: async () => '/memory',
    ensureDefaultFolder: async () => '/memory',
    setFolder: async (p) => p,
    list: async () =>
      [...files.entries()].map(([name, c]) => ({ name, modifiedMs: 0, size: c.length })),
    read: async (name) => {
      const c = files.get(name);
      if (c === undefined) throw new Error('not found');
      return c;
    },
    write: async (name, content) => {
      files.set(name, content);
    },
    rename: async (from, to) => {
      const c = files.get(from);
      if (c === undefined) throw new Error('not found');
      files.delete(from);
      files.set(to, c);
    },
    delete: async (name) => {
      files.delete(name);
    },
    reveal: async () => {
      /* no-op in browser dev */
    },
    browse: async () =>
      [...files.entries()].map(([name, c]) => ({
        name,
        kind: 'text' as const,
        modifiedMs: 0,
        size: c.length,
      })),
    readDataUrl: async () => '',
    openExternal: async () => {},
  };
}

export function createFilesApi(): FilesApi {
  if (!isTauri()) return createMemoryFilesApi();
  return {
    async pickFolder() {
      const picked = await open({ directory: true, multiple: false });
      return typeof picked === 'string' ? picked : null;
    },
    getFolder: () => invoke('notes_get_folder'),
    ensureDefaultFolder: () => invoke('notes_default_folder'),
    setFolder: (path) => invoke('notes_set_folder', { path }),
    async list() {
      const entries = await invoke<Array<{ name: string; modified_ms: number; size: number }>>(
        'notes_list',
      );
      return entries.map((e) => ({ name: e.name, modifiedMs: e.modified_ms, size: e.size }));
    },
    read: (name) => invoke('notes_read', { name }),
    write: (name, content) => invoke('notes_write', { name, content }),
    rename: (from, to) => invoke('notes_rename', { from, to }),
    delete: (name) => invoke('notes_delete', { name }),
    async reveal() {
      // Only create the default if no folder is configured yet — never
      // overwrite a folder the user picked themselves.
      const current = await invoke<string | null>('notes_get_folder');
      if (!current) await invoke('notes_default_folder');
      await invoke('notes_reveal_folder');
    },
    async browse() {
      const entries =
        await invoke<Array<{ name: string; kind: string; modified_ms: number; size: number }>>(
          'files_browse',
        );
      return entries.map((e) => ({
        name: e.name,
        kind: e.kind as 'text' | 'image' | 'pdf' | 'html',
        modifiedMs: e.modified_ms,
        size: e.size,
      }));
    },
    readDataUrl: (name) => invoke('files_read_data_url', { name }),
    openExternal: (name) => invoke('files_open_external', { name }),
  };
}
