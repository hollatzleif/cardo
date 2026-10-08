/**
 * The device-agnostic sync loop – semantic port of sync_engine.rs:
 * pull → decrypt → LWW-apply, then drain the local change log → encrypt →
 * push. The transport only ever sees `EncryptedOp` blobs.
 *
 * Shared with Rust:
 *  - a blob that fails to decrypt is counted (`undecryptable`) and dropped –
 *    it is not authentic;
 *  - an op that decrypts but that this build cannot parse or apply (unknown
 *    op kind from a newer client, an id/field a newer validator accepts,
 *    malformed JSON) is PARKED with this build's `PARK_STAMP` and counted as
 *    `rejected`; a build with a different stamp retries it at the start of
 *    its next pull. Never dropped, never fatal.
 *
 * Intentional difference from Rust: the pull loop continues while the
 * cursor advances and stops when it did not change (Rust also stops on the
 * first empty batch, which strands the cursor before a file that holds no
 * usable ops).
 *
 * Change events of a pull batch are emitted once per document after the
 * batch (when the store supports `emitChanges`), and `report.notices` holds
 * one notice per document – a large pull must not flood listeners.
 */
import { SyncCipher } from './cipher';
import { encodeSyncOp, decodeSyncOp, SyncOpParseError } from './wire';
import {
  ValidationError,
  type ChangeNotice,
  type EncryptedOp,
  type SyncOp,
  type SyncReport,
  type SyncStore,
  type SyncTransport,
} from './types';

export const PUSH_BATCH = 500;

/**
 * Identifies what this build can apply. Bump the number whenever the store
 * learns to accept ops it refused before (new op kind, relaxed validator):
 * parked ops with another stamp are then retried.
 */
export const APPLY_VERSION = 1;
export const PARK_STAMP = `ts-apply-${APPLY_VERSION}`;

export interface SyncEngineOptions {
  /** Namespaces kept off the wire in both directions (e.g. "core.layout"). */
  exclude?: readonly string[];
}

export function emptyReport(): SyncReport {
  return {
    pushed: 0,
    pulled: 0,
    applied: 0,
    skipped: 0,
    undecryptable: 0,
    rejected: 0,
    unparked: 0,
    brokenFiles: 0,
    notices: [],
  };
}

type Outcome =
  | { kind: 'applied'; notice: ChangeNotice }
  | { kind: 'skipped' }
  | { kind: 'refused'; reason: string };

export class SyncEngine {
  readonly #store: SyncStore;
  readonly #cipher: SyncCipher;
  readonly #transportId: string;
  readonly #exclude: readonly string[];

  constructor(store: SyncStore, dataKey: Uint8Array, transportId: string, options: SyncEngineOptions = {}) {
    this.#store = store;
    this.#cipher = new SyncCipher(dataKey);
    this.#transportId = transportId;
    this.#exclude = [...(options.exclude ?? [])];
  }

  /** One full round: pull first (shrinks the conflict window), then push. */
  async syncOnce(transport: SyncTransport): Promise<SyncReport> {
    const report = emptyReport();
    await this.#pullAndApply(transport, report);
    await this.#pushPending(transport, report);
    return report;
  }

  /** Pull half only (policy checks before anything of this device reaches the hub). */
  async pullOnce(transport: SyncTransport): Promise<SyncReport> {
    const report = emptyReport();
    await this.#pullAndApply(transport, report);
    return report;
  }

  async pushOnce(transport: SyncTransport): Promise<SyncReport> {
    const report = emptyReport();
    await this.#pushPending(transport, report);
    return report;
  }

  /** Decodes and applies one authentic plaintext. Store/IO errors propagate. */
  async #apply(payload: Uint8Array, quiet: boolean): Promise<Outcome> {
    let op: SyncOp;
    try {
      op = decodeSyncOp(payload);
    } catch (err) {
      if (!(err instanceof SyncOpParseError)) throw err;
      return { kind: 'refused', reason: `parse: ${err.message}` };
    }
    if (this.#exclude.includes(op.namespace)) return { kind: 'skipped' };
    try {
      const notice = await this.#store.applyRemoteOp(op, quiet ? { emit: false } : {});
      return notice ? { kind: 'applied', notice } : { kind: 'skipped' };
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      return { kind: 'refused', reason: `${err.kind}: ${err.message}` };
    }
  }

  async #pullAndApply(transport: SyncTransport, report: SyncReport): Promise<void> {
    const quiet = typeof this.#store.emitChanges === 'function';
    const notices = new Map<string, ChangeNotice>();
    const pending: ChangeNotice[] = [];
    const record = (notice: ChangeNotice) => {
      report.applied += 1;
      const key = `${notice.namespace}\u0000${notice.docId}`;
      notices.delete(key); // re-insert: keeps "last change" order
      notices.set(key, notice);
      pending.push(notice);
    };
    const flush = () => {
      if (pending.length === 0) return;
      const perDoc = new Map<string, ChangeNotice>();
      for (const n of pending) {
        const key = `${n.namespace}\u0000${n.docId}`;
        perDoc.delete(key);
        perDoc.set(key, n);
      }
      pending.length = 0;
      if (quiet) this.#store.emitChanges?.([...perDoc.values()]);
    };

    // Ops an older/other build parked: retry once per build.
    for (const parked of await this.#store.parkedOps(PARK_STAMP)) {
      const outcome = await this.#apply(parked.payload, quiet);
      if (outcome.kind === 'refused') {
        await this.#store.parkOp({ ...parked, reason: outcome.reason, stamp: PARK_STAMP });
        continue;
      }
      await this.#store.unparkOp(parked.opId);
      report.unparked += 1;
      if (outcome.kind === 'applied') record(outcome.notice);
      else report.skipped += 1;
    }
    flush();

    let cursor = await this.#store.cursorGet(this.#transportId);
    for (;;) {
      const batch = await transport.pull(cursor);
      report.pulled += batch.ops.length;
      report.brokenFiles += batch.brokenFiles ?? 0;
      for (const encrypted of batch.ops) {
        const payload = this.#open(encrypted);
        if (!payload) {
          report.undecryptable += 1;
          continue;
        }
        const outcome = await this.#apply(payload, quiet);
        if (outcome.kind === 'applied') record(outcome.notice);
        else if (outcome.kind === 'skipped') report.skipped += 1;
        else {
          report.rejected += 1;
          await this.#store.parkOp({
            opId: encrypted.opId,
            payload,
            reason: outcome.reason,
            stamp: PARK_STAMP,
          });
        }
      }
      flush();
      if (batch.nextCursor === cursor) break; // no progress – avoid spinning
      cursor = batch.nextCursor;
      await this.#store.cursorSet(this.#transportId, cursor);
    }
    report.notices = [...notices.values()];
  }

  #open(encrypted: EncryptedOp): Uint8Array | null {
    try {
      return this.#cipher.decrypt(encrypted.opId, encrypted.blob);
    } catch {
      return null;
    }
  }

  async #pushPending(transport: SyncTransport, report: SyncReport): Promise<void> {
    for (;;) {
      const pending = await this.#store.unsyncedOps(PUSH_BATCH, this.#exclude);
      if (pending.length === 0) break;
      const encrypted = pending.map((op) => ({
        opId: op.op_id,
        blob: this.#cipher.encrypt(op.op_id, encodeSyncOp(op)),
      }));
      await transport.push(encrypted);
      // Only after the transport accepted the batch: never lose ops.
      await this.#store.markOpsSynced(pending.map((op) => op.op_id));
      report.pushed += encrypted.length;
      if (encrypted.length < PUSH_BATCH) break;
    }
  }
}
