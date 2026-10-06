/**
 * Wire and store types of the Cardo sync protocol. Mirrors
 * crates/cardo-core/src/{storage.rs, sync.rs, sync_engine.rs}; the snake_case
 * field names of `SyncOp` ARE the protocol – do not rename.
 */

export type OpKind = 'create' | 'set_field' | 'delete_field' | 'delete_doc';

/** One change-log row in wire shape (Rust `SyncOp`). */
export interface SyncOp {
  op_id: string;
  device_id: string;
  hlc: string;
  namespace: string;
  doc_id: string;
  /** Normally an `OpKind`; foreign/newer devices may send anything. */
  op: string;
  field: string | null;
  /** `null` = absent (serde maps JSON null to `None` on decode). */
  value: unknown;
  created_at: number;
}

/** An end-to-end encrypted op: the only thing a transport ever sees. */
export interface EncryptedOp {
  opId: string;
  blob: Uint8Array;
}

export interface PullBatch {
  ops: EncryptedOp[];
  nextCursor: string;
}

export interface SyncTransport {
  push(ops: EncryptedOp[]): Promise<void>;
  pull(since: string): Promise<PullBatch>;
}

/** Rust `ChangeNotice` (serialized with `docId`, `ops_logged`). */
export interface ChangeNotice {
  namespace: string;
  docId: string;
  operation: 'create' | 'update' | 'delete';
  ops_logged: number;
}

export interface SyncReport {
  /** Ops uploaded this round. */
  pushed: number;
  /** Ops downloaded this round (before dedupe/LWW). */
  pulled: number;
  /** Ops that actually changed a document. */
  applied: number;
  /** Duplicates, own echoes, LWW losers and excluded namespaces. */
  skipped: number;
  /** Blobs that failed to decrypt or parse – surfaced, never fatal. */
  undecryptable: number;
  /** Ops that decrypted but failed validation (TS-only; Rust aborts the round). */
  rejected: number;
  /** Document changes for UI refresh events. */
  notices: ChangeNotice[];
}

/** What the sync engine needs from a local store (Rust `SqliteStorage` sync half). */
export interface SyncStore {
  deviceId(): Promise<string>;
  /** Unsynced local ops in log order, excluding whole namespaces. */
  unsyncedOps(limit: number, exclude: readonly string[]): Promise<SyncOp[]>;
  markOpsSynced(opIds: readonly string[]): Promise<void>;
  /** Re-queues every own op for upload; returns how many were re-queued. */
  markAllUnsynced(): Promise<number>;
  unsyncedOpCount(): Promise<number>;
  isOpKnown(opId: string): Promise<boolean>;
  cursorGet(transport: string): Promise<string>;
  cursorSet(transport: string, cursor: string): Promise<void>;
  /**
   * LWW-applies one remote op. Returns a notice when a document changed,
   * null for duplicates and LWW losers. Throws `ValidationError` for an
   * invalid namespace/id, or – only when the op would win – an invalid
   * field or unknown op kind.
   */
  applyRemoteOp(op: SyncOp): Promise<ChangeNotice | null>;
}

export type ValidationKind = 'namespace' | 'id' | 'field' | 'op' | 'not-an-object';

export class ValidationError extends Error {
  readonly kind: ValidationKind;
  readonly subject: string;
  constructor(kind: ValidationKind, subject: string, message?: string) {
    super(message ?? `invalid ${kind}: ${subject}`);
    this.name = 'ValidationError';
    this.kind = kind;
    this.subject = subject;
  }
}
