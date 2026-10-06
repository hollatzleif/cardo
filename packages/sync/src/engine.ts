/**
 * The device-agnostic sync loop – semantic port of sync_engine.rs:
 * pull → decrypt → LWW-apply, then drain the local change log → encrypt →
 * push. The transport only ever sees `EncryptedOp` blobs.
 *
 * Intentional differences from Rust:
 *  - the pull loop continues while the cursor advances and stops when it
 *    did not change (Rust also stops on the first empty batch, which strands
 *    the cursor before a file that holds no usable ops);
 *  - an op that decrypts but fails validation is counted in
 *    `report.rejected` and skipped instead of aborting the whole round.
 */
import { SyncCipher } from './cipher';
import { encodeSyncOp, decodeSyncOp } from './wire';
import {
  ValidationError,
  type EncryptedOp,
  type SyncOp,
  type SyncReport,
  type SyncStore,
  type SyncTransport,
} from './types';

export const PUSH_BATCH = 500;

export interface SyncEngineOptions {
  /** Namespaces kept off the wire in both directions (e.g. "core.layout"). */
  exclude?: readonly string[];
}

export function emptyReport(): SyncReport {
  return { pushed: 0, pulled: 0, applied: 0, skipped: 0, undecryptable: 0, rejected: 0, notices: [] };
}

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

  async #pullAndApply(transport: SyncTransport, report: SyncReport): Promise<void> {
    let cursor = await this.#store.cursorGet(this.#transportId);
    for (;;) {
      const batch = await transport.pull(cursor);
      report.pulled += batch.ops.length;
      for (const encrypted of batch.ops) {
        const op = this.#open(encrypted);
        if (!op) {
          report.undecryptable += 1;
          continue;
        }
        if (this.#exclude.includes(op.namespace)) {
          report.skipped += 1;
          continue;
        }
        try {
          const notice = await this.#store.applyRemoteOp(op);
          if (notice) {
            report.applied += 1;
            report.notices.push(notice);
          } else {
            report.skipped += 1;
          }
        } catch (err) {
          if (!(err instanceof ValidationError)) throw err;
          report.rejected += 1;
        }
      }
      if (batch.nextCursor === cursor) break; // no progress – avoid spinning
      cursor = batch.nextCursor;
      await this.#store.cursorSet(this.#transportId, cursor);
    }
  }

  #open(encrypted: EncryptedOp): SyncOp | null {
    try {
      return decodeSyncOp(this.#cipher.decrypt(encrypted.opId, encrypted.blob));
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
