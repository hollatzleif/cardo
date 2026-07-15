import type { FilesApi, ToolStorage } from '@cardo/plugin-api';

/**
 * Storage abstraction for the single scratchpad note: a real markdown FILE
 * ("scratchpad.md") when the host provides a file backend, a storage doc
 * otherwise (scratch/self-test context).
 */

export const PAD_FILE = 'scratchpad.md';
export const PAD_DOC_ID = 'pad';

type PadDoc = { id: string; content: string; updatedAt: string };

export interface PadStore {
  load(): Promise<string>;
  save(content: string): Promise<void>;
}

export function createPadStore(files: FilesApi | undefined, storage: ToolStorage): PadStore {
  if (files) {
    return {
      async load() {
        if ((await files.getFolder()) === null) await files.ensureDefaultFolder();
        try {
          return await files.read(PAD_FILE);
        } catch {
          return ''; // file does not exist yet – an empty pad
        }
      },
      async save(content) {
        if ((await files.getFolder()) === null) await files.ensureDefaultFolder();
        await files.write(PAD_FILE, content);
      },
    };
  }
  return {
    async load() {
      const doc = await storage.get<PadDoc>(PAD_DOC_ID);
      return doc?.content ?? '';
    },
    async save(content) {
      await storage.set<PadDoc>(PAD_DOC_ID, {
        id: PAD_DOC_ID,
        content,
        updatedAt: new Date().toISOString(),
      });
    },
  };
}
