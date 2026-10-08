//! Shared helpers for the cross-language sync fixture tests.
#![allow(dead_code)]

use std::path::PathBuf;

use serde_json::Value;

/// `crates/cardo-core/tests/fixtures/sync-v1`
pub fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sync-v1")
}

/// Generators only run with `CARDO_WRITE_VECTORS=1` (and `--ignored`).
pub fn writing_enabled() -> bool {
    std::env::var("CARDO_WRITE_VECTORS").as_deref() == Ok("1")
}

pub fn read_json(name: &str) -> Value {
    let path = fixtures_dir().join(name);
    let raw = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path:?}: {e}"));
    serde_json::from_slice(&raw).unwrap_or_else(|e| panic!("parse {path:?}: {e}"))
}

pub fn write_json(name: &str, value: &Value) {
    let path = fixtures_dir().join(name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    let mut text = serde_json::to_string_pretty(value).unwrap();
    text.push('\n');
    std::fs::write(&path, text).unwrap_or_else(|e| panic!("write {path:?}: {e}"));
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn unhex(text: &str) -> Vec<u8> {
    assert!(text.len() % 2 == 0, "odd hex length");
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
        .collect()
}

/* ── base32 (RFC 4648 alphabet, no padding) — mirrors sync_keys.rs ───── */

const B32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

pub fn base32_encode(data: &[u8]) -> String {
    let mut out = String::new();
    let mut buffer: u64 = 0;
    let mut bits = 0u32;
    for &byte in data {
        buffer = (buffer << 8) | u64::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(B32[((buffer >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(B32[((buffer << (5 - bits)) & 0x1f) as usize] as char);
    }
    out
}

pub fn base32_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut buffer: u64 = 0;
    let mut bits = 0u32;
    for c in text.bytes() {
        let value = B32.iter().position(|&a| a == c)? as u64;
        buffer = (buffer << 5) | value;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    Some(out)
}

/// "CRD1-" + base32 grouped in fours, exactly like `SyncKey::display`.
pub fn display_key(payload: &[u8]) -> String {
    let encoded = base32_encode(payload);
    let grouped = encoded
        .as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).unwrap())
        .collect::<Vec<_>>()
        .join("-");
    format!("CRD1-{grouped}")
}

/// Raw 33-byte payload of a well-formed key string.
pub fn key_payload(display: &str) -> Vec<u8> {
    let cleaned: String = display
        .trim()
        .to_ascii_uppercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    base32_decode(cleaned.strip_prefix("CRD1").expect("CRD1 prefix")).expect("base32")
}

/* ── base64 (std alphabet, padded) — mirrors sync_folder.rs ─────────── */

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn b64_encode(data: &[u8]) -> String {
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

pub fn b64_decode(text: &str) -> Vec<u8> {
    let cleaned: Vec<u8> = text.bytes().filter(|&b| b != b'=').collect();
    let mut out = Vec::new();
    for chunk in cleaned.chunks(4) {
        let mut n: u32 = 0;
        for &c in chunk {
            n = (n << 6) | B64.iter().position(|&a| a == c).expect("base64 char") as u32;
        }
        match chunk.len() {
            4 => out.extend_from_slice(&[(n >> 16) as u8, (n >> 8) as u8, n as u8]),
            3 => {
                n <<= 6;
                out.extend_from_slice(&[(n >> 16) as u8, (n >> 8) as u8]);
            }
            2 => {
                n <<= 12;
                out.push((n >> 16) as u8);
            }
            _ => panic!("broken base64"),
        }
    }
    out
}

/// The fixed fixture key: (display string, 32-byte data key).
pub fn fixture_key() -> (String, [u8; 32]) {
    let key = read_json("key.json");
    let display = key["key"].as_str().expect("key.json: key").to_string();
    let data_key: [u8; 32] = unhex(key["dataKeyHex"].as_str().expect("dataKeyHex"))
        .try_into()
        .expect("32-byte data key");
    (display, data_key)
}
