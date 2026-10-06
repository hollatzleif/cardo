/**
 * SyncOp plaintext codec. Encoding is byte-identical to
 * `serde_json::to_vec(&SyncOp)` (struct field order, compact, value with
 * sorted keys); decoding follows serde's rules for the struct.
 */
import { utf8Decode, utf8Encode } from './bytes';
import { formatJsonNumber, isPlainObject, stableStringify } from './json';
import type { SyncOp } from './types';

export function serializeSyncOp(op: SyncOp): string {
  const str = (s: string) => JSON.stringify(s);
  return (
    `{"op_id":${str(op.op_id)},"device_id":${str(op.device_id)},"hlc":${str(op.hlc)},` +
    `"namespace":${str(op.namespace)},"doc_id":${str(op.doc_id)},"op":${str(op.op)},` +
    `"field":${op.field == null ? 'null' : str(op.field)},` +
    `"value":${op.value == null ? 'null' : stableStringify(op.value)},` +
    `"created_at":${formatJsonNumber(op.created_at)}}`
  );
}

export function encodeSyncOp(op: SyncOp): Uint8Array {
  return utf8Encode(serializeSyncOp(op));
}

export class SyncOpParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncOpParseError';
  }
}

/** Throws `SyncOpParseError` where serde would fail to deserialize. */
export function parseSyncOp(text: string): SyncOp {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SyncOpParseError('op is not valid JSON');
  }
  if (!isPlainObject(raw)) throw new SyncOpParseError('op is not an object');
  const str = (key: string): string => {
    const v = raw[key];
    if (typeof v !== 'string') throw new SyncOpParseError(`op.${key} must be a string`);
    return v;
  };
  const field = raw.field;
  if (field != null && typeof field !== 'string') {
    throw new SyncOpParseError('op.field must be a string or null');
  }
  const createdAt = raw.created_at;
  if (typeof createdAt !== 'number' || !Number.isInteger(createdAt)) {
    throw new SyncOpParseError('op.created_at must be an integer');
  }
  return {
    op_id: str('op_id'),
    device_id: str('device_id'),
    hlc: str('hlc'),
    namespace: str('namespace'),
    doc_id: str('doc_id'),
    op: str('op'),
    field: field ?? null,
    value: raw.value ?? null,
    created_at: createdAt,
  };
}

export function decodeSyncOp(bytes: Uint8Array): SyncOp {
  let text: string;
  try {
    text = utf8Decode(bytes);
  } catch {
    throw new SyncOpParseError('op is not valid UTF-8');
  }
  return parseSyncOp(text);
}
