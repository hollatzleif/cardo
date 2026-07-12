import type {
  ChangeEvent,
  EventBus,
  StorageQuery,
  ToolContext,
  ToolStorage,
  CommandSpec,
} from './index';

/**
 * In-memory implementations for tool unit tests and self-tests.
 * Mirrors the host semantics (namespacing, query filtering) without SQLite.
 */

export function createMemoryStorage(): ToolStorage & { dump(): Map<string, unknown> } {
  const store = new Map<string, Record<string, unknown>>();
  const subscribers = new Set<(c: ChangeEvent) => void>();
  const emit = (docId: string, operation: ChangeEvent['operation']) =>
    subscribers.forEach((cb) => cb({ namespace: 'test', docId, operation }));

  return {
    async get(id) {
      return (store.get(id) as never) ?? null;
    },
    async set(id, value) {
      const existed = store.has(id);
      store.set(id, value);
      emit(id, existed ? 'update' : 'create');
    },
    async delete(id) {
      store.delete(id);
      emit(id, 'delete');
    },
    async query(q?: StorageQuery) {
      let rows = [...store.values()];
      for (const f of q?.where ?? []) {
        rows = rows.filter((row) => {
          const v = row[f.field];
          switch (f.op) {
            case '=': return v === f.value;
            case '!=': return v !== f.value;
            case '<': return (v as number) < (f.value as number);
            case '>': return (v as number) > (f.value as number);
            case '<=': return (v as number) <= (f.value as number);
            case '>=': return (v as number) >= (f.value as number);
            case 'like': return String(v).includes(String(f.value));
            case 'in': return Array.isArray(f.value) && f.value.includes(v);
          }
        });
      }
      if (q?.orderBy) {
        const key = q.orderBy;
        const dir = q.direction === 'desc' ? -1 : 1;
        rows.sort((a, b) => ((a[key] as never) > (b[key] as never) ? dir : -dir));
      }
      if (q?.limit) rows = rows.slice(0, q.limit);
      return rows as never;
    },
    subscribe(cb) {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    dump: () => store as never,
  };
}

export function createMemoryEventBus(): EventBus {
  const handlers = new Map<string, Set<(p: never) => void>>();
  return {
    emit(event, payload) {
      handlers.get(event)?.forEach((cb) => cb(payload as never));
    },
    on(event, cb) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(cb as never);
      return () => handlers.get(event)?.delete(cb as never);
    },
  };
}

export function createTestContext(
  overrides: Partial<ToolContext> = {},
): ToolContext & { registeredCommands: Map<string, CommandSpec<never>> } {
  const registeredCommands = new Map<string, CommandSpec<never>>();
  const storage = createMemoryStorage();
  const ctx: ToolContext = {
    storage,
    events: createMemoryEventBus(),
    commands: {
      register(spec) {
        registeredCommands.set(spec.id, spec as never);
      },
      async execute(id, params) {
        const spec = registeredCommands.get(id);
        if (!spec) return { ok: false, messageKey: 'common.error' };
        const parsed = spec.params.safeParse(params);
        if (!parsed.success) return { ok: false, messageKey: 'common.error' };
        return spec.run(parsed.data as never);
      },
      has: (id) => registeredCommands.has(id),
    },
    search: { register: () => {} },
    settings: (() => {
      const s = new Map<string, unknown>();
      return {
        async get(k) {
          return (s.get(k) as never) ?? null;
        },
        async set(k, v) {
          s.set(k, v);
        },
        subscribe: () => () => {},
      };
    })(),
    notifications: { notify: async () => {} },
    scheduler: {
      scheduleAt: async () => 'test-schedule',
      cancel: async () => {},
      list: async () => [],
    },
    i18n: { t: (key) => key, language: 'en' },
    theme: { token: (name) => `var(--${name})` },
    ...overrides,
  };
  return Object.assign(ctx, { registeredCommands });
}
