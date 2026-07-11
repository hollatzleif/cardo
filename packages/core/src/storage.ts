import type { ChangeEvent, StorageQuery, ToolStorage } from '@cardo/plugin-api';

/**
 * StorageBackend – what the host environment provides.
 * Desktop: Tauri invoke → Rust SqliteStorage (writes doc + change log atomically).
 * Tests/browser dev: in-memory implementation.
 */
export interface StorageBackend {
  get(namespace: string, id: string): Promise<unknown | null>;
  set(namespace: string, id: string, value: Record<string, unknown>): Promise<void>;
  delete(namespace: string, id: string): Promise<void>;
  query(namespace: string, q: StorageQuery): Promise<unknown[]>;
  /** Subscribe to change events across all namespaces. */
  onChange(cb: (ev: ChangeEvent) => void): () => void;
}

const NAMESPACE_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)?$/;

/** Hands a tool a storage instance that is hard-scoped to its namespace. */
export function createNamespacedStorage(backend: StorageBackend, namespace: string): ToolStorage {
  if (!NAMESPACE_RE.test(namespace)) {
    throw new Error(`Invalid storage namespace: ${namespace}`);
  }
  return {
    get: <T>(id: string) => backend.get(namespace, id) as Promise<T | null>,
    set: (id, value) => backend.set(namespace, id, value),
    delete: (id) => backend.delete(namespace, id),
    query: <T>(q?: StorageQuery) => backend.query(namespace, q ?? {}) as Promise<T[]>,
    subscribe(cb) {
      return backend.onChange((ev) => {
        if (ev.namespace === namespace) cb(ev);
      });
    },
  };
}

/** In-memory backend for tests and browser-only development. */
export function createMemoryBackend(): StorageBackend {
  const stores = new Map<string, Map<string, Record<string, unknown>>>();
  const listeners = new Set<(ev: ChangeEvent) => void>();
  const ns = (namespace: string) => {
    if (!stores.has(namespace)) stores.set(namespace, new Map());
    return stores.get(namespace)!;
  };
  const emit = (ev: ChangeEvent) => listeners.forEach((cb) => cb(ev));

  return {
    async get(namespace, id) {
      return ns(namespace).get(id) ?? null;
    },
    async set(namespace, id, value) {
      const existed = ns(namespace).has(id);
      ns(namespace).set(id, value);
      emit({ namespace, docId: id, operation: existed ? 'update' : 'create' });
    },
    async delete(namespace, id) {
      ns(namespace).delete(id);
      emit({ namespace, docId: id, operation: 'delete' });
    },
    async query(namespace, q) {
      let rows = [...ns(namespace).values()];
      for (const f of q.where ?? []) {
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
            default: return true;
          }
        });
      }
      if (q.orderBy) {
        const key = q.orderBy;
        const dir = q.direction === 'desc' ? -1 : 1;
        rows.sort((a, b) => ((a[key] as never) > (b[key] as never) ? dir : -dir));
      }
      if (q.limit) rows = rows.slice(0, q.limit);
      return rows;
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
