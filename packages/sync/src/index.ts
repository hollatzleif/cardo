/**
 * @cardo/sync – TypeScript port of Cardo's end-to-end encrypted sync
 * (crates/cardo-core sync_*.rs), byte-compatible with the desktop so the PWA
 * can share the same hub.
 */
export * from './types';
export { b64Decode, b64Encode } from './b64';
export { base32Decode, base32Encode } from './base32';
export { compareUtf8, toHex, utf8Length } from './bytes';
export {
  deriveKeys,
  displaySyncKey,
  generateSyncKey,
  parseSyncKey,
  KEY_PREFIX,
  SyncKeyError,
  type DerivedKeys,
  type SyncKey,
} from './keys';
export { NONCE_LEN, openRaw, sealRaw, SyncCipher, SyncCipherError } from './cipher';
export { formatHlc, Hlc, HLC_ZERO, tickHlc, type HlcState } from './hlc';
export { uuidV4, uuidV7 } from './uuid';
export {
  deepEqual,
  formatJsonNumber,
  isValidField,
  isValidId,
  isValidNamespace,
  normalizeDoc,
  stableStringify,
  validateField,
  validateId,
  validateNamespace,
  type JsonValue,
} from './json';
export { decodeSyncOp, encodeSyncOp, parseSyncOp, serializeSyncOp, SyncOpParseError } from './wire';
export {
  BATCH_EXT,
  BATCH_VERSION,
  BatchFileError,
  batchFileName,
  decodeBatchFile,
  encodeBatchFile,
  isBatchFileName,
  pullBatchFiles,
  PULL_FILE_LIMIT,
} from './batchFile';
export { notesContentHash } from './notes';
export { emptyReport, PUSH_BATCH, SyncEngine, type SyncEngineOptions } from './engine';
export * from './idb';
export { MemoryHub } from './testing/memoryHub';
