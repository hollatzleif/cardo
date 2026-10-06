/**
 * The Cardo sync key ("CRD1-…") – exact port of sync_keys.rs.
 *
 * base32 payload (33 bytes): version (1) || license_id (8) || secret (20) || check (4)
 * check = first 4 bytes of SHA-256 over the preceding 29 bytes.
 * auth_token = HKDF-SHA256(secret, salt="cardo-sync-v1", info="auth") → hex
 * data_key   = HKDF-SHA256(secret, salt="cardo-sync-v1", info="data") → 32 bytes
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { base32Decode, base32Encode } from './base32';
import { bytesEqual, concatBytes, randomBytes, toHex, utf8Encode } from './bytes';

export const KEY_PREFIX = 'CRD1';
const VERSION_SELF = 0x01;
const LICENSE_LEN = 8;
const SECRET_LEN = 20;
const CHECK_LEN = 4;
const PAYLOAD_LEN = 1 + LICENSE_LEN + SECRET_LEN + CHECK_LEN;
const HKDF_SALT = utf8Encode('cardo-sync-v1');

export class SyncKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncKeyError';
  }
}

export interface DerivedKeys {
  /** Hex string, safe to hand to a backend for authentication. */
  authToken: string;
  /** AEAD key for the E2E layer. Never serialize, never log. */
  dataKey: Uint8Array;
  /** Hex license id – the "account" grouping devices of one user. */
  licenseId: string;
}

export interface SyncKey {
  readonly licenseId: Uint8Array;
  readonly secret: Uint8Array;
}

export function generateSyncKey(): SyncKey {
  return { licenseId: randomBytes(LICENSE_LEN), secret: randomBytes(SECRET_LEN) };
}

/** Renders the shareable "CRD1-XXXX-…" string (uppercase base32, dashed in fours). */
export function displaySyncKey(key: SyncKey): string {
  const body = concatBytes(Uint8Array.of(VERSION_SELF), key.licenseId, key.secret);
  const payload = concatBytes(body, sha256(body).subarray(0, CHECK_LEN));
  const encoded = base32Encode(payload);
  const groups: string[] = [];
  for (let i = 0; i < encoded.length; i += 4) groups.push(encoded.slice(i, i + 4));
  return `${KEY_PREFIX}-${groups.join('-')}`;
}

/** Parses and offline-verifies a key; whitespace, dashes and case are forgiven. */
export function parseSyncKey(input: string): SyncKey {
  // Rust: trim → to_ascii_uppercase → keep ASCII alphanumerics only.
  const cleaned = [...input.trim()]
    .map((c) => (c >= 'a' && c <= 'z' ? c.toUpperCase() : c))
    .filter((c) => /^[A-Za-z0-9]$/.test(c))
    .join('');
  if (!cleaned.startsWith(KEY_PREFIX)) {
    throw new SyncKeyError('not a Cardo sync key (missing CRD1)');
  }
  const payload = base32Decode(cleaned.slice(KEY_PREFIX.length));
  if (!payload) throw new SyncKeyError('sync key contains invalid characters');
  if (payload.length !== PAYLOAD_LEN) throw new SyncKeyError('sync key has the wrong length');
  if (payload[0] !== VERSION_SELF) {
    throw new SyncKeyError(
      `unsupported sync key version 0x${(payload[0] ?? 0).toString(16).padStart(2, '0')}`,
    );
  }
  const body = payload.subarray(0, PAYLOAD_LEN - CHECK_LEN);
  const check = payload.subarray(PAYLOAD_LEN - CHECK_LEN);
  if (!bytesEqual(sha256(body).subarray(0, CHECK_LEN), check)) {
    throw new SyncKeyError('sync key checksum mismatch (typo?)');
  }
  return {
    licenseId: body.slice(1, 1 + LICENSE_LEN),
    secret: body.slice(1 + LICENSE_LEN),
  };
}

/** HKDF split: one backend-facing token, one local-only data key. */
export function deriveKeys(key: SyncKey): DerivedKeys {
  const auth = hkdf(sha256, key.secret, HKDF_SALT, utf8Encode('auth'), 32);
  const data = hkdf(sha256, key.secret, HKDF_SALT, utf8Encode('data'), 32);
  return { authToken: toHex(auth), dataKey: data, licenseId: toHex(key.licenseId) };
}
