/**
 * XChaCha20-Poly1305 with a random 24-byte nonce prepended to the
 * ciphertext; the op id is the associated data. Port of sync_crypto.rs.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

import { concatBytes, randomBytes, utf8Encode } from './bytes';

export const NONCE_LEN = 24;

export class SyncCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncCipherError';
  }
}

/** Raw AEAD seal (ciphertext || tag) – exposed for test vectors with binary AAD. */
export function sealRaw(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  return xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
}

/** Raw AEAD open; throws on authentication failure. */
export function openRaw(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Uint8Array {
  return xchacha20poly1305(key, nonce, aad).decrypt(sealed);
}

export class SyncCipher {
  readonly #key: Uint8Array;

  constructor(dataKey: Uint8Array) {
    if (dataKey.length !== 32) throw new SyncCipherError('data key must be 32 bytes');
    this.#key = Uint8Array.from(dataKey);
  }

  /** `nonce` is for test vectors only – production always uses a fresh random one. */
  encrypt(opId: string, plaintext: Uint8Array, nonce?: Uint8Array): Uint8Array {
    const n = nonce ?? randomBytes(NONCE_LEN);
    if (n.length !== NONCE_LEN) throw new SyncCipherError('nonce must be 24 bytes');
    const sealed = sealRaw(this.#key, n, utf8Encode(opId), plaintext);
    return concatBytes(n, sealed);
  }

  decrypt(opId: string, blob: Uint8Array): Uint8Array {
    if (blob.length <= NONCE_LEN) throw new SyncCipherError('sync blob too short');
    const nonce = blob.subarray(0, NONCE_LEN);
    const sealed = blob.subarray(NONCE_LEN);
    try {
      return openRaw(this.#key, nonce, utf8Encode(opId), sealed);
    } catch {
      throw new SyncCipherError('sync blob failed to decrypt (wrong key or tampered)');
    }
  }
}
