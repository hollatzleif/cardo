import { invoke } from '@tauri-apps/api/core';
import type { FetchedNorm, LegalApi, LegalBook, LegalNorm, LegalSourceInfo } from '@cardo/plugin-api';

/**
 * Host-side LegalApi: thin wrappers over the Rust legal commands. The adapters
 * (and their host allow-list) live in Rust so tools never fetch legal sites
 * themselves. Provided to tools only inside the Tauri host.
 */
export function createLegalApi(): LegalApi {
  return {
    sources: () => invoke<LegalSourceInfo[]>('legal_sources'),
    listBooks: (sourceId) => invoke<LegalBook[]>('legal_list_books', { sourceId }),
    listNorms: (sourceId, book) => invoke<LegalNorm[]>('legal_list_norms', { sourceId, book }),
    fetchNorm: (sourceId, book, norm, section) =>
      invoke<FetchedNorm>('legal_fetch_norm', { sourceId, book, norm, section }),
    pisteKeyPresent: () => invoke<boolean>('legal_piste_key_present'),
    setPisteKey: (clientId, clientSecret) =>
      invoke<void>('legal_set_piste_key', { clientId, clientSecret }),
    clearPisteKey: () => invoke<void>('legal_clear_piste_key'),
  };
}
