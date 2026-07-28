use hkdf::Hkdf;
use sha2::{Digest, Sha256};

use crate::error::{CoreError, Result};

/// The Cardo sync key ("CRD1-…").
///
/// Layout of the base32 payload (33 bytes):
///   version (1) || license_id (8) || secret (20) || check (4)
///
/// * `license_id` – random identifier of the key "account"; shared by every
///   device that entered the same key. Safe to show to a backend.
/// * `secret` – 160 bits of entropy. NEVER leaves the device; both derived
///   keys come from it via HKDF-SHA256.
/// * `check` – first 4 bytes of SHA-256 over the preceding bytes: offline
///   typo detection. Version 0x02 (issued keys, paid/relay tier) will carry
///   an Ed25519 signature here instead – the parser slot is ready.
///
/// Derivation (domain-separated):
///   auth_token = HKDF(secret, salt="cardo-sync-v1", info="auth")  → hex,
///     the only credential a backend ever sees.
///   data_key   = HKDF(secret, salt="cardo-sync-v1", info="data")  → 32 B,
///     encrypts every op end-to-end; the backend stores opaque blobs only.
pub const KEY_PREFIX: &str = "CRD1";

const VERSION_SELF: u8 = 0x01;
const LICENSE_LEN: usize = 8;
const SECRET_LEN: usize = 20;
const CHECK_LEN: usize = 4;
const PAYLOAD_LEN: usize = 1 + LICENSE_LEN + SECRET_LEN + CHECK_LEN;

const HKDF_SALT: &[u8] = b"cardo-sync-v1";

/// Parsed + verified sync key.
pub struct SyncKey {
    license_id: [u8; LICENSE_LEN],
    secret: [u8; SECRET_LEN],
}

/// What the rest of the app works with; the raw secret stays in here.
pub struct DerivedKeys {
    /// Hex string, safe to hand to a backend for authentication.
    pub auth_token: String,
    /// AEAD key for the E2E layer. Never serialized, never logged.
    pub data_key: [u8; 32],
    /// Hex license id – the "account" grouping devices of one user.
    pub license_id: String,
}

impl SyncKey {
    /// Generates a fresh self-issued key from OS randomness.
    pub fn generate() -> Result<Self> {
        let mut license_id = [0u8; LICENSE_LEN];
        let mut secret = [0u8; SECRET_LEN];
        getrandom::getrandom(&mut license_id)
            .and_then(|()| getrandom::getrandom(&mut secret))
            .map_err(|e| CoreError::Other(format!("no OS randomness: {e}")))?;
        Ok(Self { license_id, secret })
    }

    /// Renders the shareable "CRD1-XXXX-…" string (uppercase base32, dashed).
    pub fn display(&self) -> String {
        let mut payload = Vec::with_capacity(PAYLOAD_LEN);
        payload.push(VERSION_SELF);
        payload.extend_from_slice(&self.license_id);
        payload.extend_from_slice(&self.secret);
        let check = Sha256::digest(&payload);
        payload.extend_from_slice(&check[..CHECK_LEN]);

        let encoded = base32_encode(&payload);
        let grouped = encoded
            .as_bytes()
            .chunks(4)
            .map(|c| std::str::from_utf8(c).expect("base32 is ascii"))
            .collect::<Vec<_>>()
            .join("-");
        format!("{KEY_PREFIX}-{grouped}")
    }

    /// Parses and offline-verifies a key string (whitespace/dashes/case are
    /// forgiven – keys get typed by hand).
    pub fn parse(input: &str) -> Result<Self> {
        let cleaned: String = input
            .trim()
            .to_ascii_uppercase()
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect();
        let body = cleaned
            .strip_prefix(KEY_PREFIX)
            .ok_or_else(|| CoreError::Other("not a Cardo sync key (missing CRD1)".into()))?;

        let payload = base32_decode(body)
            .ok_or_else(|| CoreError::Other("sync key contains invalid characters".into()))?;
        if payload.len() != PAYLOAD_LEN {
            return Err(CoreError::Other("sync key has the wrong length".into()));
        }
        if payload[0] != VERSION_SELF {
            return Err(CoreError::Other(format!(
                "unsupported sync key version {:#04x}",
                payload[0]
            )));
        }

        let (body_bytes, check) = payload.split_at(PAYLOAD_LEN - CHECK_LEN);
        let expected = Sha256::digest(body_bytes);
        if &expected[..CHECK_LEN] != check {
            return Err(CoreError::Other("sync key checksum mismatch (typo?)".into()));
        }

        let mut license_id = [0u8; LICENSE_LEN];
        let mut secret = [0u8; SECRET_LEN];
        license_id.copy_from_slice(&body_bytes[1..1 + LICENSE_LEN]);
        secret.copy_from_slice(&body_bytes[1 + LICENSE_LEN..]);
        Ok(Self { license_id, secret })
    }

    /// HKDF split: one backend-facing token, one local-only data key.
    pub fn derive(&self) -> DerivedKeys {
        let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), &self.secret);
        let mut auth = [0u8; 32];
        let mut data = [0u8; 32];
        hk.expand(b"auth", &mut auth).expect("32 bytes is a valid hkdf length");
        hk.expand(b"data", &mut data).expect("32 bytes is a valid hkdf length");
        DerivedKeys {
            auth_token: hex(&auth),
            data_key: data,
            license_id: hex(&self.license_id),
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/* ── base32 (RFC 4648, no padding) ────────────────────────────────────── */

const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

fn base32_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(5) * 8);
    let mut buffer: u64 = 0;
    let mut bits = 0u32;
    for &byte in data {
        buffer = (buffer << 8) | u64::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            let index = ((buffer >> bits) & 0x1f) as usize;
            out.push(ALPHABET[index] as char);
        }
    }
    if bits > 0 {
        let index = ((buffer << (5 - bits)) & 0x1f) as usize;
        out.push(ALPHABET[index] as char);
    }
    out
}

fn base32_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 5 / 8);
    let mut buffer: u64 = 0;
    let mut bits = 0u32;
    for c in text.bytes() {
        let value = ALPHABET.iter().position(|&a| a == c)? as u64;
        buffer = (buffer << 5) | value;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_display_parse_roundtrip() {
        let key = SyncKey::generate().unwrap();
        let shown = key.display();
        assert!(shown.starts_with("CRD1-"));
        let parsed = SyncKey::parse(&shown).unwrap();
        assert_eq!(parsed.license_id, key.license_id);
        assert_eq!(parsed.secret, key.secret);
    }

    #[test]
    fn parse_forgives_case_whitespace_and_dashes() {
        let key = SyncKey::generate().unwrap();
        let shown = key.display();
        let sloppy = format!("  {}  ", shown.to_ascii_lowercase().replace('-', " "));
        let parsed = SyncKey::parse(&sloppy).unwrap();
        assert_eq!(parsed.secret, key.secret);
    }

    /// Positions of real base32 characters in a displayed key (dashes are
    /// only grouping and get stripped before parsing).
    fn payload_positions(shown: &str) -> Vec<usize> {
        (0..shown.len()).filter(|&i| shown.as_bytes()[i] != b'-').collect()
    }

    #[test]
    fn a_typo_in_any_character_is_detected() {
        // The previous version of this test flipped `shown[len - 2]`, believing
        // it to be a payload character. It is the DASH before the final group:
        // 33 payload bytes encode to 53 base32 characters, and 53 in groups of
        // four leaves a last group of exactly one. Replacing a separator
        // lengthens the cleaned body instead of altering a character, and the
        // result happened to be rejected only ~85% of the time — so the test
        // failed at random and proved nothing about typo detection.
        //
        // This checks the property that was meant: every single-character typo
        // in the key must be caught.
        for _ in 0..20 {
            let key = SyncKey::generate().unwrap();
            let shown = key.display();
            let positions = payload_positions(&shown);
            // The final character is covered by its own test below.
            for &idx in &positions[..positions.len() - 1] {
                let original = shown.as_bytes()[idx] as char;
                let replacement = if original == 'A' { 'B' } else { 'A' };
                let mut typo = shown.clone();
                typo.replace_range(idx..idx + 1, &replacement.to_string());
                assert!(
                    SyncKey::parse(&typo).is_err(),
                    "typo at {idx} ({original} → {replacement}) slipped through: {typo}"
                );
            }
        }
    }

    #[test]
    fn a_typo_in_the_final_character_never_yields_a_different_key() {
        // 33 bytes = 264 bits, but 53 base32 characters carry 265. The spare
        // bit is discarded on decode, so the last character holds only four
        // meaningful bits and roughly 7% of typos there are NOT rejected.
        //
        // That is harmless, and this test pins down why: such a typo decodes
        // to the very same payload, so the user still gets the correct key.
        // What must never happen is a typo producing a DIFFERENT key that
        // parses cleanly — that would sync against the wrong identity.
        for _ in 0..50 {
            let key = SyncKey::generate().unwrap();
            let shown = key.display();
            let last = *payload_positions(&shown).last().unwrap();

            for replacement in ALPHABET.iter().map(|&b| b as char) {
                let mut typo = shown.clone();
                typo.replace_range(last..last + 1, &replacement.to_string());
                if let Ok(parsed) = SyncKey::parse(&typo) {
                    assert_eq!(
                        (parsed.secret, parsed.license_id),
                        (key.secret, key.license_id),
                        "a typo in the last character produced a DIFFERENT key: {typo}"
                    );
                }
            }
        }
    }

    #[test]
    fn derivation_is_deterministic_and_domain_separated() {
        let key = SyncKey::generate().unwrap();
        let a = key.derive();
        let b = key.derive();
        assert_eq!(a.auth_token, b.auth_token);
        assert_eq!(a.data_key, b.data_key);
        assert_eq!(a.license_id, b.license_id);
        // auth token must not leak the data key.
        assert_ne!(a.auth_token, hex(&a.data_key));
        assert_eq!(a.auth_token.len(), 64);
        assert_eq!(a.license_id.len(), LICENSE_LEN * 2);
    }

    #[test]
    fn different_keys_derive_different_material() {
        let a = SyncKey::generate().unwrap().derive();
        let b = SyncKey::generate().unwrap().derive();
        assert_ne!(a.auth_token, b.auth_token);
        assert_ne!(a.data_key, b.data_key);
    }

    #[test]
    fn base32_roundtrip() {
        for len in 0..40 {
            let data: Vec<u8> = (0..len as u8).collect();
            let encoded = base32_encode(&data);
            assert_eq!(base32_decode(&encoded).unwrap(), data);
        }
    }

    #[test]
    fn rejects_foreign_and_broken_input() {
        assert!(SyncKey::parse("").is_err());
        assert!(SyncKey::parse("HELLO-WORLD").is_err());
        assert!(SyncKey::parse("CRD1-TOO-SHORT").is_err());
    }
}

