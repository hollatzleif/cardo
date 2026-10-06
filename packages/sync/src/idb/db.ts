/** IndexedDB schema and small promise helpers (no dependencies). */

/** 2: `parked` store (ops this build refused, kept for a later upgrade). */
export const SCHEMA_VERSION = 2;

export const STORES = {
  docs: 'docs',
  log: 'log',
  clocks: 'clocks',
  applied: 'applied',
  cursors: 'cursors',
  meta: 'meta',
  local: 'local',
  parked: 'parked',
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

export interface DocRecord {
  ns: string;
  id: string;
  data: unknown;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
  /**
   * SQLite rowid stand-in: assigned when the (ns, id) record is first
   * created and kept forever (tombstones and resurrections included), like
   * the rowid of a `documents` row that is only ever upserted. Ties of
   * `updatedAt` are broken by it in query results. Absent on records written
   * before it existed (they sort first, then by id).
   */
  rowSeq?: number;
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

export interface ParkedRecord {
  op_id: string;
  /** Decrypted op bytes (authentic: the AEAD check passed). */
  payload: Uint8Array;
  reason: string;
  /** `PARK_STAMP` of the build that refused it. */
  stamp: string;
  parkedAt: number;
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
      if (!db.objectStoreNames.contains(STORES.parked)) {
        db.createObjectStore(STORES.parked, { keyPath: 'op_id' });
      }
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
