/**
 * IndexedDB store for the PWA: a `StorageBackend` (what tools see, like the
 * desktop's Tauri bridge) AND a `SyncStore` (what the sync engine needs).
 * It reproduces SqliteStorage (storage.rs) op for op:
 *
 *  - set(): missing/deleted doc → one `create`; live doc → `set_field` per
 *    changed key (sorted by UTF-8 bytes, like serde's BTreeMap), then
 *    `delete_field` per removed key; nothing logged when unchanged.
 *  - delete(): `delete_doc` tombstone only when the doc was live.
 *  - applyRemoteOp(): LWW per field, see below.
 *
 * Object stores: docs [ns,id]; log (seq, unique op_id, synced index);
 * clocks [ns, docId, slot] → max hlc; applied; cursors; meta; local.
 *
 * The `clocks` store replaces Rust's `MAX(hlc)` queries over the change log
 * (which never shrinks, so a running max is exact). Slots: `#all` (every
 * op), `#doc` (create/delete_doc) and `f:<field>` (ops carrying that field).
 * Field slots are prefixed so no field name can collide with `#doc`/`#all`.
 *
 * Every operation runs in one IndexedDB transaction; inside it only IDB
 * requests are awaited (ids/hlc are generated synchronously; the hlc state is
 * read and written in the same transaction, which keeps it monotonic across
 * restarts and tabs).
 */
import type { ChangeEvent, StorageQuery } from '@cardo/plugin-api';
import type { StorageBackend } from '@cardo/core';

import { compareUtf8 } from '../bytes';
import { formatHlc, HLC_ZERO, isHlcState, tickHlc, type HlcState } from '../hlc';
import {
  deepEqual,
  isPlainObject,
  normalizeDoc,
  sortedKeys,
  stableStringify,
  validateField,
  validateId,
  validateNamespace,
} from '../json';
import { ValidationError, type ChangeNotice, type SyncOp, type SyncStore } from '../types';
import { uuidV4, uuidV7 } from '../uuid';
import {
  inTransaction,
  iterate,
  openDatabase,
  req,
  SCHEMA_VERSION,
  STORES,
  type AppliedRecord,
  type DocRecord,
  type LogRecord,
  type StoreName,
} from './db';
import { runQuery, validateQuery } from './query';

export interface ChangeLogEntry {
  seq: number;
  opId: string;
  deviceId: string;
  hlc: string;
  op: string;
  field: string | null;
  value: unknown;
  createdAt: number;
  synced: boolean;
}

export interface DocWithMeta {
  id: string;
  data: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface IdbStoreOptions {
  /** Defaults to `globalThis.indexedDB`. */
  indexedDB?: IDBFactory;
  /** Wall clock (ms); injectable for tests. */
  now?: () => number;
  /** Cross-tab change events via BroadcastChannel (default: when available). */
  broadcast?: boolean;
}

export interface IdbStore extends StorageBackend, SyncStore {
  readonly ready: Promise<void>;
  /** set() returning the Rust-style notice. */
  write(namespace: string, id: string, value: Record<string, unknown>): Promise<ChangeNotice>;
  /** delete() returning the Rust-style notice. */
  remove(namespace: string, id: string): Promise<ChangeNotice>;
  /** Live document ids of a namespace in byte order (Rust `list_ids`). */
  listIds(namespace: string): Promise<string[]>;
  listWithMeta(namespace: string): Promise<DocWithMeta[]>;
  /** Every live document grouped by namespace (Rust `dump_all`). */
  dumpAll(): Promise<Record<string, Record<string, unknown>>>;
  changeLogFor(namespace: string, id: string): Promise<ChangeLogEntry[]>;
  /** Device-only key/value (never logged, never synced). */
  localGet<T = unknown>(key: string): Promise<T | null>;
  localSet(key: string, value: unknown): Promise<void>;
  localDelete(key: string): Promise<void>;
  /** Clears documents, log, clocks, applied ops, cursors and local values; keeps device id and hlc. */
  wipe(): Promise<void>;
  close(): void;
}

const BROADCAST_CHANNEL = 'cardo-storage';
const ALL_SLOT = '#all';
const DOC_SLOT = '#doc';
const fieldSlot = (field: string) => `f:${field}`;

interface BroadcastMessage {
  db: string;
  event: ChangeEvent;
}

function toSyncOp(rec: LogRecord): SyncOp {
  return {
    op_id: rec.op_id,
    device_id: rec.device_id,
    hlc: rec.hlc,
    namespace: rec.namespace,
    doc_id: rec.doc_id,
    op: rec.op,
    field: rec.field,
    value: rec.value === null ? null : (JSON.parse(rec.value) as unknown),
    created_at: rec.created_at,
  };
}

export function createIdbStore(dbName: string, options: IdbStoreOptions = {}): IdbStore {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) throw new Error('IndexedDB is not available');
  const now = options.now ?? Date.now;
  const listeners = new Set<(ev: ChangeEvent) => void>();

  let db: IDBDatabase | null = null;
  let deviceId = '';
  let closed = false;

  let channel: BroadcastChannel | null = null;
  if (options.broadcast !== false && typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(BROADCAST_CHANNEL);
    (channel as unknown as { unref?: () => void }).unref?.();
    channel.onmessage = (msg: MessageEvent<BroadcastMessage>) => {
      if (msg.data?.db === dbName && msg.data.event) deliver(msg.data.event);
    };
  }

  function deliver(ev: ChangeEvent) {
    for (const cb of [...listeners]) {
      try {
        cb(ev);
      } catch (err) {
        console.error('storage change listener failed', err);
      }
    }
  }

  function emit(ev: ChangeEvent) {
    deliver(ev);
    try {
      channel?.postMessage({ db: dbName, event: ev } satisfies BroadcastMessage);
    } catch {
      // channel closed – local listeners already got it
    }
  }

  const ready = (async () => {
    db = await openDatabase(factory, dbName);
    db.onversionchange = () => db?.close();
    deviceId = await inTransaction(db, [STORES.meta], 'readwrite', async (tx) => {
      const meta = tx.objectStore(STORES.meta);
      let id = (await req(meta.get('deviceId'))) as unknown;
      if (typeof id !== 'string' || id.length === 0) {
        id = uuidV4();
        meta.put(id, 'deviceId');
        meta.put(now(), 'createdAt');
      }
      meta.put(SCHEMA_VERSION, 'schemaVersion');
      return id as string;
    });
  })();

  async function run<T>(stores: StoreName[], mode: IDBTransactionMode, body: (tx: IDBTransaction) => Promise<T>) {
    await ready;
    if (closed || !db) throw new Error('store is closed');
    return inTransaction(db, stores, mode, body);
  }

  /* ── helpers usable inside a write transaction ─────────────────────── */

  async function readHlc(tx: IDBTransaction): Promise<HlcState> {
    const raw = (await req(tx.objectStore(STORES.meta).get('hlc'))) as unknown;
    return isHlcState(raw) ? raw : HLC_ZERO;
  }

  async function bumpClock(tx: IDBTransaction, ns: string, id: string, slot: string, hlc: string) {
    const clocks = tx.objectStore(STORES.clocks);
    const key = [ns, id, slot];
    const current = (await req(clocks.get(key))) as string | undefined;
    if (current === undefined || compareUtf8(hlc, current) > 0) clocks.put(hlc, key);
  }

  async function bumpClocksFor(tx: IDBTransaction, rec: LogRecord) {
    await bumpClock(tx, rec.namespace, rec.doc_id, ALL_SLOT, rec.hlc);
    if (rec.op === 'create' || rec.op === 'delete_doc') {
      await bumpClock(tx, rec.namespace, rec.doc_id, DOC_SLOT, rec.hlc);
    }
    if (rec.field !== null) await bumpClock(tx, rec.namespace, rec.doc_id, fieldSlot(rec.field), rec.hlc);
  }

  async function maxClock(tx: IDBTransaction, ns: string, id: string, slots: string[]) {
    let max: string | undefined;
    for (const slot of slots) {
      const v = (await req(tx.objectStore(STORES.clocks).get([ns, id, slot]))) as string | undefined;
      if (v !== undefined && (max === undefined || compareUtf8(v, max) > 0)) max = v;
    }
    return max;
  }

  /** Local writer: allocates op id + hlc synchronously, logs, bumps clocks. */
  function localLogger(tx: IDBTransaction, hlcStart: HlcState) {
    let state = hlcStart;
    const pending: LogRecord[] = [];
    return {
      log(ns: string, id: string, op: string, field: string | null, value: unknown) {
        state = tickHlc(state, now());
        const rec: LogRecord = {
          op_id: uuidV7(),
          device_id: deviceId,
          hlc: formatHlc(state, deviceId),
          namespace: ns,
          doc_id: id,
          op,
          field,
          value: value === undefined ? null : stableStringify(value),
          created_at: now(),
          synced: 0,
        };
        tx.objectStore(STORES.log).add(rec);
        pending.push(rec);
      },
      async finish() {
        if (pending.length === 0) return 0;
        tx.objectStore(STORES.meta).put(state, 'hlc');
        for (const rec of pending) await bumpClocksFor(tx, rec);
        return pending.length;
      },
    };
  }

  /* ── StorageBackend ────────────────────────────────────────────────── */

  async function write(namespace: string, id: string, value: Record<string, unknown>): Promise<ChangeNotice> {
    validateNamespace(namespace);
    validateId(id);
    if (!isPlainObject(value)) throw new ValidationError('not-an-object', id, 'value is not an object');
    const doc = normalizeDoc<Record<string, unknown>>(value);

    const notice = await run(
      [STORES.docs, STORES.log, STORES.clocks, STORES.meta],
      'readwrite',
      async (tx): Promise<ChangeNotice> => {
        const docs = tx.objectStore(STORES.docs);
        const existing = (await req(docs.get([namespace, id]))) as DocRecord | undefined;
        const logger = localLogger(tx, await readHlc(tx));
        const t = now();
        let operation: ChangeNotice['operation'];

        if (!existing || existing.deleted) {
          docs.put({
            ns: namespace,
            id,
            data: doc,
            createdAt: existing?.createdAt ?? t,
            updatedAt: t,
            deleted: false,
          } satisfies DocRecord);
          logger.log(namespace, id, 'create', null, doc);
          operation = 'create';
        } else {
          const old = isPlainObject(existing.data) ? existing.data : {};
          let changed = false;
          for (const key of sortedKeys(doc)) {
            if (!Object.prototype.hasOwnProperty.call(old, key) || !deepEqual(old[key], doc[key])) {
              logger.log(namespace, id, 'set_field', key, doc[key]);
              changed = true;
            }
          }
          for (const key of sortedKeys(old)) {
            if (!Object.prototype.hasOwnProperty.call(doc, key)) {
              logger.log(namespace, id, 'delete_field', key, undefined);
              changed = true;
            }
          }
          if (changed) docs.put({ ...existing, data: doc, updatedAt: t });
          operation = 'update';
        }
        const opsLogged = await logger.finish();
        return { namespace, docId: id, operation, ops_logged: opsLogged };
      },
    );
    emit({ namespace, docId: id, operation: notice.operation });
    return notice;
  }

  async function remove(namespace: string, id: string): Promise<ChangeNotice> {
    validateNamespace(namespace);
    validateId(id);
    const notice = await run(
      [STORES.docs, STORES.log, STORES.clocks, STORES.meta],
      'readwrite',
      async (tx): Promise<ChangeNotice> => {
        const docs = tx.objectStore(STORES.docs);
        const existing = (await req(docs.get([namespace, id]))) as DocRecord | undefined;
        let opsLogged = 0;
        if (existing && !existing.deleted) {
          docs.put({ ...existing, deleted: true, updatedAt: now() });
          // Tombstone, not a hard delete: sync needs to propagate deletions.
          const logger = localLogger(tx, await readHlc(tx));
          logger.log(namespace, id, 'delete_doc', null, undefined);
          opsLogged = await logger.finish();
        }
        return { namespace, docId: id, operation: 'delete', ops_logged: opsLogged };
      },
    );
    emit({ namespace, docId: id, operation: 'delete' });
    return notice;
  }

  async function liveDocs(namespace: string): Promise<DocRecord[]> {
    const rows = await run([STORES.docs], 'readonly', async (tx) => {
      const range = IDBKeyRange.bound([namespace], [namespace, []]);
      return (await req(tx.objectStore(STORES.docs).getAll(range))) as DocRecord[];
    });
    return rows.filter((r) => !r.deleted).sort((a, b) => compareUtf8(a.id, b.id));
  }

  /* ── SyncStore ─────────────────────────────────────────────────────── */

  async function applyRemoteOp(op: SyncOp): Promise<ChangeNotice | null> {
    validateNamespace(op.namespace);
    validateId(op.doc_id);
    const notice = await run(
      [STORES.docs, STORES.log, STORES.clocks, STORES.applied],
      'readwrite',
      async (tx): Promise<ChangeNotice | null> => {
        const log = tx.objectStore(STORES.log);
        const applied = tx.objectStore(STORES.applied);
        const known =
          (await req(log.index('op_id').count(op.op_id))) + (await req(applied.count(op.op_id)));
        if (known > 0) return null;

        const isFieldOp = op.op === 'set_field' || op.op === 'delete_field';
        // Latest local knowledge this op competes against (Rust MAX(hlc) queries).
        const latest = isFieldOp
          ? await maxClock(tx, op.namespace, op.doc_id, [fieldSlot(op.field ?? ''), DOC_SLOT])
          : await maxClock(tx, op.namespace, op.doc_id, [ALL_SLOT]);
        const remoteWins = latest === undefined || compareUtf8(op.hlc, latest) > 0;
        const t = now();
        let result: ChangeNotice | null = null;

        if (remoteWins) {
          const docs = tx.objectStore(STORES.docs);
          const key = [op.namespace, op.doc_id];
          switch (op.op) {
            case 'create': {
              const existing = (await req(docs.get(key))) as DocRecord | undefined;
              docs.put({
                ns: op.namespace,
                id: op.doc_id,
                data: op.value ?? {},
                createdAt: existing?.createdAt ?? t,
                updatedAt: t,
                deleted: false,
              } satisfies DocRecord);
              result = { namespace: op.namespace, docId: op.doc_id, operation: 'create', ops_logged: 1 };
              break;
            }
            case 'set_field':
            case 'delete_field': {
              if (op.field === null) throw new ValidationError('field', '', 'field op without field');
              validateField(op.field);
              const existing = (await req(docs.get(key))) as DocRecord | undefined;
              // A field op on a tombstoned doc resurrects its old data (Rust parity).
              const doc: Record<string, unknown> = isPlainObject(existing?.data) ? { ...existing.data } : {};
              if (op.op === 'set_field') doc[op.field] = op.value ?? null;
              else delete doc[op.field];
              docs.put({
                ns: op.namespace,
                id: op.doc_id,
                data: doc,
                createdAt: existing?.createdAt ?? t,
                updatedAt: t,
                deleted: false,
              } satisfies DocRecord);
              result = { namespace: op.namespace, docId: op.doc_id, operation: 'update', ops_logged: 1 };
              break;
            }
            case 'delete_doc': {
              const existing = (await req(docs.get(key))) as DocRecord | undefined;
              if (existing) docs.put({ ...existing, deleted: true, updatedAt: t });
              result = { namespace: op.namespace, docId: op.doc_id, operation: 'delete', ops_logged: 1 };
              break;
            }
            default:
              throw new ValidationError('op', op.op, `unknown sync op "${op.op}"`);
          }
          // Winners join the log (synced=1: already on the wire) so future
          // LWW lookups see the remote hlc.
          const rec: LogRecord = {
            op_id: op.op_id,
            device_id: op.device_id,
            hlc: op.hlc,
            namespace: op.namespace,
            doc_id: op.doc_id,
            op: op.op,
            field: op.field,
            value: op.value == null ? null : stableStringify(op.value),
            created_at: op.created_at,
            synced: 1,
          };
          log.add(rec);
          await bumpClocksFor(tx, rec);
        }
        // Losers and winners alike are remembered – a pull is idempotent.
        applied.put({ op_id: op.op_id, appliedAt: t } satisfies AppliedRecord);
        return result;
      },
    );
    if (notice) emit({ namespace: notice.namespace, docId: notice.docId, operation: notice.operation });
    return notice;
  }

  const store: IdbStore = {
    ready,

    async get(namespace, id) {
      validateNamespace(namespace);
      validateId(id);
      const rec = await run([STORES.docs], 'readonly', async (tx) => {
        return (await req(tx.objectStore(STORES.docs).get([namespace, id]))) as DocRecord | undefined;
      });
      return rec && !rec.deleted ? rec.data : null;
    },

    async set(namespace, id, value) {
      await write(namespace, id, value);
    },

    async delete(namespace, id) {
      await remove(namespace, id);
    },

    async query(namespace: string, q: StorageQuery) {
      validateNamespace(namespace);
      validateQuery(q);
      return runQuery(await liveDocs(namespace), q, (r) => r.data).map((r) => r.data);
    },

    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    write,
    remove,

    async listIds(namespace) {
      validateNamespace(namespace);
      return (await liveDocs(namespace)).map((r) => r.id);
    },

    async listWithMeta(namespace) {
      validateNamespace(namespace);
      return (await liveDocs(namespace)).map((r) => ({
        id: r.id,
        data: r.data,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
    },

    async dumpAll() {
      const rows = await run([STORES.docs], 'readonly', async (tx) => {
        return (await req(tx.objectStore(STORES.docs).getAll())) as DocRecord[];
      });
      const out: Record<string, Record<string, unknown>> = {};
      rows
        .filter((r) => !r.deleted)
        .sort((a, b) => compareUtf8(a.ns, b.ns) || compareUtf8(a.id, b.id))
        .forEach((r) => {
          (out[r.ns] ??= {})[r.id] = r.data;
        });
      return out;
    },

    async changeLogFor(namespace, id) {
      const rows = await run([STORES.log], 'readonly', async (tx) => {
        return (await req(tx.objectStore(STORES.log).index('doc').getAll([namespace, id]))) as LogRecord[];
      });
      return rows
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
        .map((r) => ({
          seq: r.seq ?? 0,
          opId: r.op_id,
          deviceId: r.device_id,
          hlc: r.hlc,
          op: r.op,
          field: r.field,
          value: r.value === null ? null : (JSON.parse(r.value) as unknown),
          createdAt: r.created_at,
          synced: r.synced !== 0,
        }));
    },

    async localGet<T = unknown>(key: string) {
      const v = await run([STORES.local], 'readonly', async (tx) => req(tx.objectStore(STORES.local).get(key)));
      return v === undefined ? null : (v as T);
    },

    async localSet(key, value) {
      await run([STORES.local], 'readwrite', async (tx) => {
        await req(tx.objectStore(STORES.local).put(value, key));
      });
    },

    async localDelete(key) {
      await run([STORES.local], 'readwrite', async (tx) => {
        await req(tx.objectStore(STORES.local).delete(key));
      });
    },

    async wipe() {
      const stores = [STORES.docs, STORES.log, STORES.clocks, STORES.applied, STORES.cursors, STORES.local];
      await run(stores, 'readwrite', async (tx) => {
        for (const name of stores) await req(tx.objectStore(name).clear());
      });
    },

    close() {
      if (closed) return;
      closed = true;
      channel?.close();
      channel = null;
      listeners.clear();
      void ready.then(
        () => db?.close(),
        () => undefined,
      );
    },

    /* SyncStore */

    async deviceId() {
      await ready;
      return deviceId;
    },

    async unsyncedOps(limit, exclude) {
      return run([STORES.log], 'readonly', async (tx) => {
        const out: SyncOp[] = [];
        if (limit <= 0) return out;
        // Index order for equal keys is primary-key (seq) order = log order.
        const request = tx.objectStore(STORES.log).index('synced').openCursor(IDBKeyRange.only(0));
        await iterate(request, (cursor) => {
          const rec = cursor.value as LogRecord;
          if (!exclude.includes(rec.namespace)) out.push(toSyncOp(rec));
          return out.length < limit;
        });
        return out;
      });
    },

    async markOpsSynced(opIds) {
      if (opIds.length === 0) return;
      await run([STORES.log], 'readwrite', async (tx) => {
        const log = tx.objectStore(STORES.log);
        for (const id of opIds) {
          const rec = (await req(log.index('op_id').get(id))) as LogRecord | undefined;
          if (rec && rec.synced !== 1) log.put({ ...rec, synced: 1 });
        }
      });
    },

    async markAllUnsynced() {
      return run([STORES.log], 'readwrite', async (tx) => {
        let count = 0;
        const request = tx.objectStore(STORES.log).index('synced').openCursor(IDBKeyRange.only(1));
        await iterate(request, (cursor) => {
          const rec = cursor.value as LogRecord;
          if (rec.device_id === deviceId) {
            cursor.update({ ...rec, synced: 0 });
            count += 1;
          }
        });
        return count;
      });
    },

    async unsyncedOpCount() {
      return run([STORES.log], 'readonly', async (tx) =>
        req(tx.objectStore(STORES.log).index('synced').count(IDBKeyRange.only(0))),
      );
    },

    async isOpKnown(opId) {
      return run([STORES.log, STORES.applied], 'readonly', async (tx) => {
        const inLog = await req(tx.objectStore(STORES.log).index('op_id').count(opId));
        const inApplied = await req(tx.objectStore(STORES.applied).count(opId));
        return inLog + inApplied > 0;
      });
    },

    async cursorGet(transport) {
      const rec = await run([STORES.cursors], 'readonly', async (tx) =>
        req(tx.objectStore(STORES.cursors).get(transport)),
      );
      return isPlainObject(rec) && typeof rec.cursor === 'string' ? rec.cursor : '';
    },

    async cursorSet(transport, cursor) {
      await run([STORES.cursors], 'readwrite', async (tx) => {
        await req(tx.objectStore(STORES.cursors).put({ cursor, updatedAt: now() }, transport));
      });
    },

    applyRemoteOp,
  };
  return store;
}
