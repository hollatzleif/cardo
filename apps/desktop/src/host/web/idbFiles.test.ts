import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createIdbStore } from '@cardo/sync';
import { contentHash, createIdbFilesApi, MAX_NOTE_BYTES, NOTES_NS, validNoteName } from './idbFiles';

describe('notes on the web app', () => {
  it('stores notes as files.notes docs with the desktop hash', async () => {
    const store = createIdbStore('files-test-1', { broadcast: false });
    await store.ready;
    const files = createIdbFilesApi(store);
    await files.write('Einkauf.md', 'Milch\r\nÄpfel 🍎');
    expect(await store.get(NOTES_NS, 'Einkauf.md')).toEqual({
      content: 'Milch\r\nÄpfel 🍎',
      hash: contentHash('Milch\r\nÄpfel 🍎'),
    });
    expect((await files.list()).map((f) => f.name)).toEqual(['Einkauf.md']);
    await files.rename('Einkauf.md', 'Liste.md');
    expect(await files.read('Liste.md')).toBe('Milch\r\nÄpfel 🍎');
    await expect(files.read('Einkauf.md')).rejects.toThrow();
    store.close();
  });

  it('refuses names and sizes the desktop would not carry', async () => {
    const store = createIdbStore('files-test-2', { broadcast: false });
    await store.ready;
    const files = createIdbFilesApi(store);
    await expect(files.write('../x.md', 'a')).rejects.toThrow();
    await expect(files.write('big.md', 'a'.repeat(MAX_NOTE_BYTES + 1))).rejects.toThrow();
    expect(validNoteName('.hidden.md')).toBe(false);
    expect(validNoteName('a/b.md')).toBe(false);
    expect(validNoteName('ok.md')).toBe(true);
    expect(validNoteName('ok.txt')).toBe(false);
    store.close();
  });

  it('hash is sha256 hex of the UTF-8 content', () => {
    expect(contentHash('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
