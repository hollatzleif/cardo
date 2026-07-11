import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { FilesApi } from '@cardo/plugin-api';

/**
 * FilesApi backed by the Rust notes commands. The webview only ever sends
 * file NAMES; Rust resolves and validates them inside the configured folder.
 */
export function createFilesApi(): FilesApi {
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
  };
}
