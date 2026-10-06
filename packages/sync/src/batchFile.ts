/**
 * Hub batch files, shared by the folder and Google Drive transports:
 * `ops/<created_ms:013>-<uuidv4>.cardo-ops` containing
 * `{"version":1,"ops":[{"op_id":…,"blob_b64":…}]}`. The cursor is the last
 * file name processed; names sort chronologically.
 */
import { b64Decode, b64Encode } from './b64';
import { compareUtf8 } from './bytes';
import { isPlainObject } from './json';
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
 * Decodes a batch file. Returns null for an unknown version (skip the file,
 * a newer client wrote it). Unparseable JSON throws; individual ops without
 * op_id/blob_b64 or with broken base64 are dropped (like the Drive transport).
 */
export function decodeBatchFile(text: string): EncryptedOp[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BatchFileError('batch file is not valid JSON');
  }
  if (!isPlainObject(raw)) throw new BatchFileError('batch file is not an object');
  if (raw.version !== BATCH_VERSION) return null;
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
 * Shared pull logic of name-addressed hubs: every batch file after `since`
 * in name order, at most PULL_FILE_LIMIT files; the cursor advances past
 * skipped (unknown-version) files too.
 */
export async function pullBatchFiles(
  names: readonly string[],
  since: string,
  read: (name: string) => Promise<string>,
): Promise<PullBatch> {
  const pending = names
    .filter((n) => isBatchFileName(n) && compareUtf8(n, since) > 0)
    .sort(compareUtf8)
    .slice(0, PULL_FILE_LIMIT);
  const ops: EncryptedOp[] = [];
  let cursor = since;
  for (const name of pending) {
    const decoded = decodeBatchFile(await read(name));
    if (decoded) ops.push(...decoded);
    cursor = name;
  }
  return { ops, nextCursor: cursor };
}
