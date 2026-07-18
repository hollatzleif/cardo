import { describe, it, expect } from 'vitest';
import type { SelfTestContext, ToolStorage } from '@cardo/plugin-api';
import { createTool } from './index';

function memoryStorage(): ToolStorage {
  const map = new Map<string, Record<string, unknown>>();
  return {
    async get(id) {
      return (map.get(id) as never) ?? null;
    },
    async set(id, value) {
      map.set(id, value as Record<string, unknown>);
    },
    async delete(id) {
      map.delete(id);
    },
    async query(q) {
      const where = q?.where ?? [];
      return [...map.values()].filter((doc) =>
        where.every((f) => f.op === '=' && (doc as Record<string, unknown>)[f.field] === f.value),
      ) as never[];
    },
    subscribe() {
      return () => {};
    },
  };
}

function ctx(): SelfTestContext {
  return { storage: memoryStorage() } as unknown as SelfTestContext;
}

describe('legal-dictionary self-tests pass', () => {
  for (const id of ['render', 'storage'] as const) {
    it(id, async () => {
      const tool = createTool();
      const result = await tool.runSelfTest(id, ctx());
      expect(result.status, 'detail' in result ? result.detail : '').toBe('pass');
    });
  }
});
