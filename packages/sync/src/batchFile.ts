/**
 * Hub batch files, shared by the folder and Google Drive transports:
 * `ops/<created_ms:013>-<uuidv4>.cardo-ops` containing
 * `{"version":1,"ops":[{"op_id":…,"blob_b64":…}]}`. Names sort
 * chronologically (uploader clock); the pull cursor is a look-back cursor.
 */
import { b64Decode, b64Encode } from './b64';
import { compareUtf8 } from './bytes';
import { isPlainObject } from './json';
import { advanceCursor, parseCursor, renderCursor, selectDue } from './lookback';
import type { EncryptedOp, PullBatch } from './types';
import { uuidV4 } from './uuid';

export const BATCH_EXT = '.cardo-ops';
export const BATCH_VERSION = 1;
/** Files per pull call (both Rust transports take 50). */
export const PULL_FILE_LIMIT = 50;

export class BatchFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BatchFileError';
  }
}

export function batchFileName(nowMs: number = Date.now(), id: string = uuidV4()): string {
  return `${String(Math.floor(nowMs)).padStart(13, '0')}-${id}${BATCH_EXT}`;
}

/** Hidden temp files (".name.tmp") and foreign files are ignored. */
export function isBatchFileName(name: string): boolean {
  return name.endsWith(BATCH_EXT) && !name.startsWith('.');
}

/** Same byte layout as Rust `serde_json::to_vec(&BatchFile)`. */
export function encodeBatchFile(ops: readonly EncryptedOp[]): string {
  const items = ops.map(
    (op) => `{"op_id":${JSON.stringify(op.opId)},"blob_b64":${JSON.stringify(b64Encode(op.blob))}}`,
  );
  return `{"version":${BATCH_VERSION},"ops":[${items.join(',')}]}`;
}

/**
 * Decodes a batch file exactly like `decode_batch_file` in sync_folder.rs
 * (shared by every Rust transport). Throws `BatchFileError` when the file is
 * broken (not JSON, not an object, no `ops` array) – callers skip such a file
 * and mark it read. `version` is not checked (Rust does not either: a newer
 * file's ops either decrypt and apply, park, or count as undecryptable).
 * Single entries without string op_id/blob_b64 or with broken base64 are
 * dropped. Never returns null (the type keeps old callers compiling).
 */
export function decodeBatchFile(text: string): EncryptedOp[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BatchFileError('batch file is not valid JSON');
  }
  if (!isPlainObject(raw)) throw new BatchFileError('batch file is not an object');
  if (!Array.isArray(raw.ops)) throw new BatchFileError('batch file has no ops array');
  const out: EncryptedOp[] = [];
  for (const item of raw.ops) {
    if (!isPlainObject(item)) continue;
    const { op_id: opId, blob_b64: blobB64 } = item;
    if (typeof opId !== 'string' || typeof blobB64 !== 'string') continue;
    const blob = b64Decode(blobB64);
    if (!blob) continue;
    out.push({ opId, blob });
  }
  return out;
}

/**
 * Shared pull logic of name-addressed hubs (FolderTransport parity): the
 * due files of the look-back cursor (lookback.ts) in name order, at most
 * PULL_FILE_LIMIT; broken files are counted, skipped and marked read; read
 * errors propagate (retry next round).
 */
export async function pullBatchFiles(
  names: readonly string[],
  since: string,
  read: (name: string) => Promise<string>,
  nowMs: number = Date.now(),
): Promise<PullBatch> {
  const sorted = [...new Set(names.filter(isBatchFileName))].sort(compareUtf8);
  const cursor = parseCursor(since);
  const due = selectDue(cursor, sorted, PULL_FILE_LIMIT, nowMs);
  const ops: EncryptedOp[] = [];
  let brokenFiles = 0;
  for (const name of due) {
    const text = await read(name);
    try {
      ops.push(...(decodeBatchFile(text) ?? []));
    } catch (err) {
      if (!(err instanceof BatchFileError)) throw err;
      brokenFiles += 1;
    }
  }
  return { ops, nextCursor: renderCursor(advanceCursor(cursor, due, nowMs)), brokenFiles };
}
