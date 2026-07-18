import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { AnkiApi, AnkiCollection } from '@cardo/plugin-api';

/**
 * Host-side AnkiApi: opens the OS file dialog and parses/writes `.apkg` via the
 * Rust adapter (zip + SQLite). Provided to the flashcards tool only inside the
 * Tauri host.
 */
export function createAnkiApi(): AnkiApi {
  return {
    importFile: async () => {
      const path = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'Anki', extensions: ['apkg', 'colpkg'] }],
      });
      if (typeof path !== 'string') return null;
      return invoke<AnkiCollection>('anki_import', { path });
    },
    exportFile: async (collection) => {
      const path = await save({
        defaultPath: 'cardo-deck.apkg',
        filters: [{ name: 'Anki', extensions: ['apkg'] }],
      });
      if (!path) return false;
      await invoke('anki_export', { path, collection });
      return true;
    },
  };
}
