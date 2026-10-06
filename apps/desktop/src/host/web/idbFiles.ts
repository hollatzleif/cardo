import { sha256 } from '@noble/hashes/sha2.js';
import type { FileBrowseEntry, FilesApi } from '@cardo/plugin-api';
import type { StorageBackend } from '@cardo/core';

/**
 * Notes on the iPhone web app. There is no folder on a phone, so notes live
 * directly as `files.notes/<name>` documents `{content, hash}` – exactly the
 * shape the desktop's sync file lane (sync_files.rs) mirrors its .md files
 * into. Sync therefore carries them to and from the desktop's notes folder.
 */

export const NOTES_NS = 'files.notes';
/** The desktop skips (and would delete) larger files – refuse them here. */
export const MAX_NOTE_BYTES = 512 * 1024;
const FOLDER_LABEL = 'Cardo (iPhone)';

export class NoteError extends Error {
  constructor(public readonly code: 'name' | 'size' | 'missing') {
    super(`note ${code}`);
    this.name = 'NoteError';
  }
}

export function contentHash(content: string): string {
  return Array.from(sha256(new TextEncoder().encode(content)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Same rules as the desktop's safe_join + flat .md listing. */
export function validNoteName(name: string): boolean {
  return (
    name.endsWith('.md') &&
    name.length > 3 &&
    new TextEncoder().encode(name).length <= 128 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..') &&
    !name.startsWith('.') &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(name)
  );
}

interface NoteDoc {
  content?: unknown;
  hash?: unknown;
}

export function createIdbFilesApi(backend: StorageBackend & { listWithMeta?(ns: string): Promise<Array<{ id: string; data: unknown; updatedAt: number }>> }): FilesApi {
  async function all(): Promise<Array<{ name: string; content: string; modifiedMs: number }>> {
    if (backend.listWithMeta) {
      const rows = await backend.listWithMeta(NOTES_NS);
      return rows
        .filter((r) => validNoteName(r.id) && typeof (r.data as NoteDoc)?.content === 'string')
        .map((r) => ({ name: r.id, content: (r.data as NoteDoc).content as string, modifiedMs: r.updatedAt }));
    }
    return [];
  }
  async function read(name: string): Promise<string> {
    const doc = (await backend.get(NOTES_NS, name)) as NoteDoc | null;
    if (!doc || typeof doc.content !== 'string') throw new NoteError('missing');
    return doc.content;
  }
  async function write(name: string, content: string): Promise<void> {
    if (!validNoteName(name)) throw new NoteError('name');
    if (new TextEncoder().encode(content).length > MAX_NOTE_BYTES) throw new NoteError('size');
    await backend.set(NOTES_NS, name, { content, hash: contentHash(content) });
  }
  return {
    pickFolder: async () => null,
    getFolder: async () => FOLDER_LABEL,
    ensureDefaultFolder: async () => FOLDER_LABEL,
    setFolder: async () => FOLDER_LABEL,
    list: async () =>
      (await all()).map((n) => ({ name: n.name, modifiedMs: n.modifiedMs, size: new TextEncoder().encode(n.content).length })),
    read,
    write,
    async rename(from, to) {
      if (!validNoteName(to)) throw new NoteError('name');
      const content = await read(from);
      await write(to, content);
      await backend.delete(NOTES_NS, from);
    },
    delete: async (name) => backend.delete(NOTES_NS, name),
    reveal: async () => {},
    browse: async (): Promise<FileBrowseEntry[]> =>
      (await all()).map((n) => ({
        name: n.name,
        kind: 'text',
        modifiedMs: n.modifiedMs,
        size: new TextEncoder().encode(n.content).length,
      })),
    readDataUrl: async () => '',
    openExternal: async () => {},
  };
}
