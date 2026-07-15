import type { FilesApi, ToolStorage } from '@cardo/plugin-api';
import { isDecisionFileName } from './logic';

/**
 * Storage abstraction for decisions: markdown FILES when the host provides a
 * file backend, plain storage docs otherwise (scratch/self-test context).
 * Both sides speak "named markdown documents", so widget/commands/self-tests
 * never care which backend is active.
 */

export type StoredDecision = { name: string; markdown: string };

export interface DecisionStore {
  /** All decision documents (unparsed markdown), no particular order. */
  list(): Promise<StoredDecision[]>;
  add(name: string, markdown: string): Promise<void>;
  remove(name: string): Promise<void>;
}

type DecisionDoc = { id: string; type: 'decision'; name: string; markdown: string };

/** Cap so a huge folder can never stall the widget – newest files win. */
const MAX_DOCS = 100;

export function createDecisionStore(
  files: FilesApi | undefined,
  storage: ToolStorage,
): DecisionStore {
  if (files) {
    return {
      async list() {
        if ((await files.getFolder()) === null) await files.ensureDefaultFolder();
        const names = (await files.list())
          .filter((f) => isDecisionFileName(f.name))
          .sort((a, b) => b.modifiedMs - a.modifiedMs)
          .slice(0, MAX_DOCS);
        const docs = await Promise.all(
          names.map(async (f): Promise<StoredDecision | null> => {
            try {
              return { name: f.name, markdown: await files.read(f.name) };
            } catch {
              return null; // file vanished between list and read
            }
          }),
        );
        return docs.filter((d): d is StoredDecision => d !== null);
      },
      async add(name, markdown) {
        if ((await files.getFolder()) === null) await files.ensureDefaultFolder();
        await files.write(name, markdown);
      },
      async remove(name) {
        await files.delete(name);
      },
    };
  }

  return {
    async list() {
      const docs = await storage.query<DecisionDoc>({
        where: [{ field: 'type', op: '=', value: 'decision' }],
      });
      return docs.slice(0, MAX_DOCS).map((d) => ({ name: d.name, markdown: d.markdown }));
    },
    async add(name, markdown) {
      const doc: DecisionDoc = { id: `decision:${name}`, type: 'decision', name, markdown };
      await storage.set(doc.id, doc);
    },
    async remove(name) {
      await storage.delete(`decision:${name}`);
    },
  };
}
