/** IndexedDB schema and small promise helpers (no dependencies). */

export const SCHEMA_VERSION = 1;

export const STORES = {
  docs: 'docs',
  log: 'log',
  clocks: 'clocks',
  applied: 'applied',
  cursors: 'cursors',
  meta: 'meta',
  local: 'local',
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

export interface DocRecord {
  ns: string;
  id: string;
  data: unknown;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
}

export interface LogRecord {
  seq?: number;
  op_id: string;
  device_id: string;
  hlc: string;
  namespace: string;
  doc_id: string;
  op: string;
  field: string | null;
  /** JSON text (like the SQLite column) or null. */
  value: string | null;
  created_at: number;
  /** 0 | 1 – booleans are not valid IndexedDB keys. */
  synced: number;
}

export interface AppliedRecord {
  op_id: string;
  appliedAt: number;
}

export function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, SCHEMA_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORES.docs)) {
        db.createObjectStore(STORES.docs, { keyPath: ['ns', 'id'] });
      }
      if (!db.objectStoreNames.contains(STORES.log)) {
        const log = db.createObjectStore(STORES.log, { keyPath: 'seq', autoIncrement: true });
        log.createIndex('op_id', 'op_id', { unique: true });
        log.createIndex('synced', 'synced');
        log.createIndex('doc', ['namespace', 'doc_id']);
      }
      // Key [ns, docId, slot] → max hlc; see store.ts for the slot scheme.
      if (!db.objectStoreNames.contains(STORES.clocks)) db.createObjectStore(STORES.clocks);
      if (!db.objectStoreNames.contains(STORES.applied)) {
        db.createObjectStore(STORES.applied, { keyPath: 'op_id' });
      }
      if (!db.objectStoreNames.contains(STORES.cursors)) db.createObjectStore(STORES.cursors);
      if (!db.objectStoreNames.contains(STORES.meta)) db.createObjectStore(STORES.meta);
      if (!db.objectStoreNames.contains(STORES.local)) db.createObjectStore(STORES.local);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`cannot open ${name}`));
  });
}

export function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * Runs `body` inside ONE transaction. `body` may only await IndexedDB
 * requests (via `req`) – any other await would let the transaction commit
 * early. A throw aborts the transaction (all-or-nothing like SQLite).
 */
export async function inTransaction<T>(
  db: IDBDatabase,
  stores: StoreName[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const tx = db.transaction(stores, mode);
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
  let result: T;
  try {
    result = await body(tx);
  } catch (err) {
    try {
      tx.abort();
    } catch {
      // already finished
    }
    await done.catch(() => undefined);
    throw err;
  }
  await done;
  return result;
}

/** Walks a cursor; `visit` returns false to stop early. */
export function iterate(
  request: IDBRequest<IDBCursorWithValue | null>,
  visit: (cursor: IDBCursorWithValue) => boolean | void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve();
      if (visit(cursor) === false) return resolve();
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed'));
  });
}
