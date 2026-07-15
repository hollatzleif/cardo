use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};

use crate::error::{CoreError, Result};

/// End-to-end encryption of sync ops: XChaCha20-Poly1305 with a random
/// 24-byte nonce per op, prepended to the ciphertext. The op id doubles as
/// associated data so a blob cannot be replayed under a different id.
/// Whatever backend carries the blobs (Drive, folder, relay) sees only
/// `nonce || ciphertext`.
pub struct SyncCipher {
    cipher: XChaCha20Poly1305,
}

const NONCE_LEN: usize = 24;

impl SyncCipher {
    pub fn new(data_key: &[u8; 32]) -> Self {
        Self { cipher: XChaCha20Poly1305::new(data_key.into()) }
    }

    pub fn encrypt(&self, op_id: &str, plaintext: &[u8]) -> Result<Vec<u8>> {
        let mut nonce = [0u8; NONCE_LEN];
        getrandom::getrandom(&mut nonce)
            .map_err(|e| CoreError::Other(format!("no OS randomness: {e}")))?;
        let sealed = self
            .cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload { msg: plaintext, aad: op_id.as_bytes() },
            )
            .map_err(|_| CoreError::Other("encryption failed".into()))?;
        let mut blob = Vec::with_capacity(NONCE_LEN + sealed.len());
        blob.extend_from_slice(&nonce);
        blob.extend_from_slice(&sealed);
        Ok(blob)
    }

    pub fn decrypt(&self, op_id: &str, blob: &[u8]) -> Result<Vec<u8>> {
        if blob.len() <= NONCE_LEN {
            return Err(CoreError::Other("sync blob too short".into()));
        }
        let (nonce, sealed) = blob.split_at(NONCE_LEN);
        self.cipher
            .decrypt(
                XNonce::from_slice(nonce),
                Payload { msg: sealed, aad: op_id.as_bytes() },
            )
            .map_err(|_| {
                CoreError::Other("sync blob failed to decrypt (wrong key or tampered)".into())
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_keys::SyncKey;

    fn cipher() -> SyncCipher {
        SyncCipher::new(&SyncKey::generate().unwrap().derive().data_key)
    }

    #[test]
    fn roundtrip() {
        let c = cipher();
        let blob = c.encrypt("op-1", b"hello sync").unwrap();
        assert_eq!(c.decrypt("op-1", &blob).unwrap(), b"hello sync");
    }

    #[test]
    fn nonce_is_random_per_op() {
        let c = cipher();
        let a = c.encrypt("op-1", b"same").unwrap();
        let b = c.encrypt("op-1", b"same").unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn wrong_key_fails() {
        let blob = cipher().encrypt("op-1", b"secret").unwrap();
        assert!(cipher().decrypt("op-1", &blob).is_err());
    }

    #[test]
    fn swapped_op_id_fails() {
        let c = cipher();
        let blob = c.encrypt("op-1", b"secret").unwrap();
        assert!(c.decrypt("op-2", &blob).is_err());
    }

    #[test]
    fn tampering_fails() {
        let c = cipher();
        let mut blob = c.encrypt("op-1", b"secret").unwrap();
        let last = blob.len() - 1;
        blob[last] ^= 0x01;
        assert!(c.decrypt("op-1", &blob).is_err());
    }

    #[test]
    fn short_blob_fails() {
        assert!(cipher().decrypt("op-1", &[0u8; 10]).is_err());
    }
}
