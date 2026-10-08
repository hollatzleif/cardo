//! Cross-language sync test vectors (consumed by the TypeScript port in
//! `packages/sync`). The fixtures live in `tests/fixtures/sync-v1/`; see the
//! README there for the format.
//!
//! * Normal tests VERIFY the committed fixtures against the real Rust code.
//! * `#[ignore]` tests REGENERATE them, guarded by `CARDO_WRITE_VECTORS=1`:
//!
//! ```text
//! # new fixed key (invalidates every other vector – only when really needed)
//! CARDO_WRITE_VECTORS=1 CARDO_FORCE_NEW_KEY=1 \
//!   cargo test -p cardo-core --test sync_vectors -- --ignored regenerate_key
//! # everything derived from key.json
//! CARDO_WRITE_VECTORS=1 cargo test -p cardo-core --test sync_vectors -- --ignored write_vectors
//! ```

mod common;

use std::path::{Path, PathBuf};

use cardo_core::sync_crypto::SyncCipher;
use cardo_core::{FolderTransport, SqliteStorage, StorageAdapter, SyncEngine, SyncKey, SyncOp};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use common::*;
use hkdf::Hkdf;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

/* ── generators ───────────────────────────────────────────────────────── */

#[test]
#[ignore = "writes tests/fixtures/sync-v1/key.json (CARDO_WRITE_VECTORS=1)"]
fn regenerate_key() {
    if !writing_enabled() {
        eprintln!("skipped: set CARDO_WRITE_VECTORS=1 to regenerate the fixture key");
        return;
    }
    let path = fixtures_dir().join("key.json");
    if path.exists() && std::env::var("CARDO_FORCE_NEW_KEY").as_deref() != Ok("1") {
        panic!("key.json exists; set CARDO_FORCE_NEW_KEY=1 to replace it (then rerun write_vectors)");
    }
    let key = SyncKey::generate().unwrap();
    let display = key.display();
    let derived = key.derive();
    let payload = key_payload(&display);
    let value = json!({
        "comment": "FIXED TEST KEY – public, never use for real data. Regenerate via the ignored regenerate_key test.",
        "key": display,
        "payloadHex": hex(&payload),
        "version": payload[0],
        "licenseId": derived.license_id,
        "secretHex": hex(&payload[9..29]),
        "checkHex": hex(&payload[29..33]),
        "hkdfSalt": "cardo-sync-v1",
        "authToken": derived.auth_token,
        "dataKeyHex": hex(&derived.data_key),
    });
    println!("{}", serde_json::to_string_pretty(&value).unwrap());
    write_json("key.json", &value);
}

#[tokio::test]
#[ignore = "rewrites the derived fixtures from key.json (CARDO_WRITE_VECTORS=1)"]
async fn write_vectors() {
    if !writing_enabled() {
        eprintln!("skipped: set CARDO_WRITE_VECTORS=1 to regenerate the sync vectors");
        return;
    }
    let (display, data_key) = fixture_key();
    write_keys_json(&display);
    write_xchacha_json(&data_key);
    write_notes_hash_json();
    write_rust_hub(&data_key).await;
}

fn write_keys_json(display: &str) {
    let derived = SyncKey::parse(display).unwrap().derive();
    let entry = |input: String, note: &str| {
        json!({
            "input": input,
            "note": note,
            "licenseId": derived.license_id,
            "authToken": derived.auth_token,
        })
    };
    let compact: String = display.chars().filter(|c| *c != '-').collect();
    let mut valid = vec![
        entry(display.to_string(), "canonical display form"),
        entry(display.to_ascii_lowercase(), "lowercase"),
        entry(display.replace('-', " "), "spaces instead of dashes"),
        entry(format!("  \t{display}\n "), "surrounding whitespace"),
        entry(compact.clone(), "no separators at all"),
        entry(display.replace('-', "\u{2013}"), "en dash separators (any non [A-Za-z0-9] char is dropped)"),
        entry(
            format!(" {} ", display.to_ascii_lowercase().replace('-', "  ")),
            "lowercase + double spaces + surrounding whitespace",
        ),
        entry(
            display.chars().enumerate().map(|(i, c)| if i % 2 == 0 { c.to_ascii_lowercase() } else { c }).collect(),
            "mixed case",
        ),
    ];
    // A second, independent key so a port cannot get away with constants.
    let other = SyncKey::generate().unwrap();
    let other_derived = other.derive();
    valid.push(json!({
        "input": other.display(),
        "note": "second independent key",
        "licenseId": other_derived.license_id,
        "authToken": other_derived.auth_token,
    }));

    let payload = key_payload(display);
    // Version 0x02 with a CORRECT checksum → must fail on the version, not the check.
    let mut v2 = payload[..29].to_vec();
    v2[0] = 0x02;
    let check = Sha256::digest(&v2);
    v2.extend_from_slice(&check[..4]);
    // Single-character typo in a payload character (not the last one, whose
    // spare bit can make a typo harmless – see sync_keys.rs tests).
    let idx = 10; // "CRD1-XXXX-X" → index 10 is a payload character
    assert_ne!(display.as_bytes()[idx], b'-');
    let original = display.as_bytes()[idx] as char;
    let mut typo = display.to_string();
    typo.replace_range(idx..idx + 1, if original == 'A' { "B" } else { "A" });
    // Bad character: '0', '1', '8', '9' are not in the base32 alphabet.
    let mut bad_char = display.to_string();
    bad_char.replace_range(idx..idx + 1, "0");
    let mut bad_char_9 = display.to_string();
    bad_char_9.replace_range(idx + 1..idx + 2, "9");
    // Wrong length: last group dropped / one byte too many.
    let short = display[..display.rfind('-').unwrap()].to_string();
    let mut long_payload = payload.clone();
    long_payload.push(0);
    let invalid = json!([
        { "input": "", "reason": "missing_prefix" },
        { "input": "HELLO-WORLD", "reason": "missing_prefix" },
        { "input": compact.trim_start_matches("CRD1"), "reason": "missing_prefix", "note": "payload without CRD1" },
        { "input": display.replacen("CRD1", "CRD2", 1), "reason": "missing_prefix" },
        { "input": bad_char, "reason": "invalid_chars" },
        { "input": bad_char_9, "reason": "invalid_chars" },
        { "input": "CRD1", "reason": "wrong_length" },
        { "input": "CRD1-TOO-SHORT", "reason": "wrong_length" },
        { "input": short, "reason": "wrong_length" },
        { "input": display_key(&long_payload), "reason": "wrong_length" },
        { "input": display_key(&v2), "reason": "unsupported_version", "note": "version 0x02 with a valid checksum" },
        { "input": typo, "reason": "checksum_mismatch", "note": "single-character typo" },
    ]);
    write_json(
        "keys.json",
        &json!({
            "comment": "SyncKey::parse vectors. reason → Rust error text: missing_prefix='missing CRD1', invalid_chars='invalid characters', wrong_length='wrong length', unsupported_version='unsupported sync key version', checksum_mismatch='checksum mismatch'. Checks run in that order.",
            "valid": valid,
            "invalid": invalid,
        }),
    );
}

/// draft-irtf-cfrg-xchacha-03, appendix A.3.1.
const DRAFT_PLAINTEXT: &str = "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.";
const DRAFT_KEY: &str = "808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f";
const DRAFT_NONCE: &str = "404142434445464748494a4b4c4d4e4f5051525354555657";
const DRAFT_AAD: &str = "50515253c0c1c2c3c4c5c6c7";
const DRAFT_CT: &str = "bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff921f9664c97637da9768812f615c68b13b52e";
const DRAFT_TAG: &str = "c0875924c1c7987947deafd8780acf49";

fn seal(key: &[u8], nonce: &[u8], aad: &[u8], plaintext: &[u8]) -> Vec<u8> {
    XChaCha20Poly1305::new_from_slice(key)
        .unwrap()
        .encrypt(XNonce::from_slice(nonce), Payload { msg: plaintext, aad })
        .unwrap()
}

fn write_xchacha_json(data_key: &[u8; 32]) {
    let op = SyncOp {
        op_id: "0192f0c4-7a1e-7b3c-9d2e-4f5a6b7c8d9e".into(),
        device_id: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b".into(),
        hlc: "1760000000000-0003-6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b".into(),
        namespace: "todo".into(),
        doc_id: "Einkäufe".into(),
        op: "set_field".into(),
        field: Some("title".into()),
        value: Some(json!({"text": "Milch 🥛 & Brötchen", "n": -3, "x": 0.25, "z": null})),
        created_at: 1760000000000,
    };
    let plaintext = serde_json::to_vec(&op).unwrap();
    let nonce: Vec<u8> = (0u8..24).collect();
    let sealed = seal(data_key, &nonce, op.op_id.as_bytes(), &plaintext);
    let (ct, tag) = sealed.split_at(sealed.len() - 16);
    let mut blob = nonce.clone();
    blob.extend_from_slice(&sealed);

    let draft_sealed = seal(
        &unhex(DRAFT_KEY),
        &unhex(DRAFT_NONCE),
        &unhex(DRAFT_AAD),
        DRAFT_PLAINTEXT.as_bytes(),
    );
    assert_eq!(hex(&draft_sealed), format!("{DRAFT_CT}{DRAFT_TAG}"), "draft vector mismatch");

    write_json(
        "xchacha-kat.json",
        &json!({
            "comment": "XChaCha20-Poly1305 known answers. sealed = ciphertext || tag (16 B). A Cardo wire blob is nonce (24 B) || sealed, AAD = op_id (UTF-8).",
            "vectors": [
                {
                    "name": "draft-irtf-cfrg-xchacha-03 A.3.1",
                    "keyHex": DRAFT_KEY,
                    "nonceHex": DRAFT_NONCE,
                    "aadHex": DRAFT_AAD,
                    "plaintextHex": hex(DRAFT_PLAINTEXT.as_bytes()),
                    "plaintextUtf8": DRAFT_PLAINTEXT,
                    "ciphertextHex": DRAFT_CT,
                    "tagHex": DRAFT_TAG,
                    "sealedHex": format!("{DRAFT_CT}{DRAFT_TAG}"),
                },
                {
                    "name": "cardo sync op with fixture data key",
                    "keyHex": hex(data_key),
                    "nonceHex": hex(&nonce),
                    "aadHex": hex(op.op_id.as_bytes()),
                    "aadUtf8": op.op_id,
                    "plaintextHex": hex(&plaintext),
                    "plaintextUtf8": String::from_utf8(plaintext.clone()).unwrap(),
                    "ciphertextHex": hex(ct),
                    "tagHex": hex(tag),
                    "sealedHex": hex(&sealed),
                    "blobHex": hex(&blob),
                    "blobB64": b64_encode(&blob),
                },
            ],
        }),
    );
}

fn note_texts() -> Vec<(&'static str, String)> {
    vec![
        ("empty", String::new()),
        ("ascii", "abc".into()),
        ("umlauts NFC", "Grüße aus Köln – Äpfel, Öl, Übermut, ß".into()),
        ("umlauts NFD (no normalization!)", "Gru\u{0308}ße".into()),
        ("emoji incl. ZWJ + flag", "Notiz 🎉👩‍💻🇩🇪 done ✅".into()),
        ("CRLF line endings", "# Titel\r\n\r\n- Punkt 1\r\n- Punkt 2\r\n".into()),
        ("LF line endings", "# Titel\n\n- Punkt 1\n- Punkt 2\n".into()),
        ("BOM is hashed as-is", "\u{feff}mit BOM".into()),
        ("tabs, NUL-free control chars", "a\tb\u{000b}c\u{001f}".into()),
        ("long markdown", "Lorem ipsum dolor sit amet. ".repeat(40)),
    ]
}

fn sha256_hex(text: &str) -> String {
    hex(&Sha256::digest(text.as_bytes()))
}

fn write_notes_hash_json() {
    let cases: Vec<Value> = note_texts()
        .into_iter()
        .map(|(name, text)| {
            json!({
                "name": name,
                "text": text,
                "utf8Hex": hex(text.as_bytes()),
                "sha256": sha256_hex(&text),
            })
        })
        .collect();
    write_json(
        "notes-hash.json",
        &json!({
            "comment": "files.notes hash = lowercase hex SHA-256 over the raw UTF-8 bytes of the file content, exactly as read (no newline or Unicode normalization, BOM kept). Mirrors content_hash() in apps/desktop/src-tauri/src/sync_files.rs. Doc value is {content, hash}.",
            "cases": cases,
        }),
    );
}

const HUB_TRANSPORT_ID: &str = "fixture-writer";

async fn write_rust_hub(data_key: &[u8; 32]) {
    let hub = fixtures_dir().join("rust-hub");
    if hub.exists() {
        std::fs::remove_dir_all(&hub).unwrap();
    }
    let tmp = TempDir::new().unwrap();
    let s = SqliteStorage::open(&tmp.path().join("writer.db")).await.unwrap();
    let transport = FolderTransport::new(&hub).unwrap();
    let engine = SyncEngine::new(&s, data_key, HUB_TRANSPORT_ID);
    let mut plaintext: Vec<SyncOp> = Vec::new();

    let note_v1 = "# Grüße 🎉\r\n\r\nErste Zeile.\r\n";
    let note_v2 = "# Grüße 🎉\r\n\r\nErste Zeile.\r\nZweite Zeile – mit Ümlaut.\r\n";
    let note = |c: &str| json!({ "content": c, "hash": sha256_hex(c) });

    // Phase 1 – creates across namespaces.
    s.set("todo", "task-1", json!({
        "type": "task", "title": "Milch kaufen", "done": false, "prio": 2,
        "tags": ["einkauf", "dringend"], "due": null,
    })).await.unwrap();
    s.set("todo", "task-2", json!({ "type": "task", "title": "Steuer 2025", "done": false, "prio": 1 }))
        .await.unwrap();
    s.set("contacts", "Jürgen Müller–Lüdenscheidt", json!({
        "name": "Jürgen Müller-Lüdenscheidt",
        "address": { "street": "Königsallee 1", "city": "Düsseldorf",
                     "geo": { "lat": 51.2254, "lng": 6.7763 } },
        "phones": ["+49 211 000000", "+49 170 1234567"],
        "balance": -1234, "neg": -42, "temp": -273.15, "ratio": 1.0, "tiny": 1.5e-7,
        "big": 9007199254740991_i64, "zero": 0,
        "emoji": "👩‍💻🇩🇪", "escapes": "tab\tquote\"backslash\\ newline\n",
        "emptyObj": {}, "emptyArr": [], "nothing": null,
        "mixed": [1, "zwei", null, true, { "k": [] }, -0.5],
    })).await.unwrap();
    s.set("files.notes", "Grüße 🎉.md", note(note_v1)).await.unwrap();
    s.set("core", "sync-devices", json!({ "devices": [
        { "deviceId": "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", "name": "Heikes MacBook", "lastSeenMs": 1760000000000_i64 },
    ]})).await.unwrap();
    s.set("core.sync-control", "join-policy", json!({ "type": "join-policy", "open": true }))
        .await.unwrap();
    flush(&s, &engine, &transport, &mut plaintext).await;

    // Phase 2 – field updates, delete_field, delete_doc, short-lived doc.
    s.set("todo", "task-1", json!({
        "type": "task", "title": "Milch & Brot kaufen", "done": true, "prio": 2,
        "tags": ["einkauf", "dringend", "rewe"],
    })).await.unwrap();
    let mut contact = s.get("contacts", "Jürgen Müller–Lüdenscheidt").await.unwrap().unwrap();
    contact["address"]["city"] = json!("Köln");
    contact["nothing"] = json!("now something");
    contact.as_object_mut().unwrap().remove("emptyArr");
    s.set("contacts", "Jürgen Müller–Lüdenscheidt", contact).await.unwrap();
    s.delete("todo", "task-2").await.unwrap();
    s.set("files.notes", "Grüße 🎉.md", note(note_v2)).await.unwrap();
    s.set("core", "sync-devices", json!({ "devices": [
        { "deviceId": "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", "name": "Heikes MacBook", "lastSeenMs": 1760000100000_i64 },
        { "deviceId": "0b8e1f2a-3c4d-4e5f-9a6b-7c8d9e0f1a2b", "name": "iPhone", "lastSeenMs": 1760000200000_i64 },
    ]})).await.unwrap();
    s.set("todo", "task-3", json!({ "type": "task", "title": "kurzlebig" })).await.unwrap();
    s.delete("todo", "task-3").await.unwrap();
    flush(&s, &engine, &transport, &mut plaintext).await;

    // Phase 3 – re-create after delete, float field, policy flip.
    s.set("todo", "task-2", json!({ "type": "task", "title": "Steuer 2025 (neu)", "done": false }))
        .await.unwrap();
    let mut t1 = s.get("todo", "task-1").await.unwrap().unwrap();
    t1["prio"] = json!(3.5);
    s.set("todo", "task-1", t1).await.unwrap();
    s.set("core.sync-control", "join-policy", json!({ "type": "join-policy", "open": false }))
        .await.unwrap();
    flush(&s, &engine, &transport, &mut plaintext).await;

    write_json("rust-hub/expected-docs.json", &s.dump_all().await.unwrap());
    write_json("rust-hub/plaintext.json", &serde_json::to_value(&plaintext).unwrap());
}

async fn flush(
    s: &SqliteStorage,
    engine: &SyncEngine<'_>,
    transport: &FolderTransport,
    plaintext: &mut Vec<SyncOp>,
) {
    let pending = s.unsynced_ops(100_000, &[]).await.unwrap();
    let report = engine.push_once(transport).await.unwrap();
    assert_eq!(report.pushed, pending.len());
    plaintext.extend(pending);
    // Distinct millisecond file names → batch files sort in push order.
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
}

/* ── verification against the committed fixtures ──────────────────────── */

#[test]
fn key_json_matches_parse_and_independent_hkdf() {
    let key = read_json("key.json");
    let display = key["key"].as_str().unwrap();
    let derived = SyncKey::parse(display).unwrap().derive();
    assert_eq!(derived.license_id, key["licenseId"].as_str().unwrap());
    assert_eq!(derived.auth_token, key["authToken"].as_str().unwrap());
    assert_eq!(hex(&derived.data_key), key["dataKeyHex"].as_str().unwrap());

    // Payload layout + independent HKDF straight from the secret.
    let payload = key_payload(display);
    assert_eq!(hex(&payload), key["payloadHex"].as_str().unwrap());
    assert_eq!(payload.len(), 33);
    assert_eq!(payload[0], 0x01);
    assert_eq!(hex(&payload[1..9]), key["licenseId"].as_str().unwrap());
    assert_eq!(&Sha256::digest(&payload[..29])[..4], &payload[29..]);
    let secret = unhex(key["secretHex"].as_str().unwrap());
    assert_eq!(secret, payload[9..29]);
    let hk = Hkdf::<Sha256>::new(Some(b"cardo-sync-v1"), &secret);
    let mut auth = [0u8; 32];
    let mut data = [0u8; 32];
    hk.expand(b"auth", &mut auth).unwrap();
    hk.expand(b"data", &mut data).unwrap();
    assert_eq!(hex(&auth), key["authToken"].as_str().unwrap());
    assert_eq!(hex(&data), key["dataKeyHex"].as_str().unwrap());
    // Display form is canonical.
    assert_eq!(display_key(&payload), display);
}

fn reason_text(reason: &str) -> &'static str {
    match reason {
        "missing_prefix" => "missing CRD1",
        "invalid_chars" => "invalid characters",
        "wrong_length" => "wrong length",
        "unsupported_version" => "unsupported sync key version",
        "checksum_mismatch" => "checksum mismatch",
        other => panic!("unknown reason {other}"),
    }
}

#[test]
fn keys_json_valid_and_invalid_inputs() {
    let keys = read_json("keys.json");
    let valid = keys["valid"].as_array().unwrap();
    assert!(valid.len() >= 5);
    for case in valid {
        let input = case["input"].as_str().unwrap();
        let derived = SyncKey::parse(input)
            .unwrap_or_else(|e| panic!("valid key rejected: {input:?}: {e}"))
            .derive();
        assert_eq!(derived.license_id, case["licenseId"].as_str().unwrap(), "{input:?}");
        assert_eq!(derived.auth_token, case["authToken"].as_str().unwrap(), "{input:?}");
    }
    let invalid = keys["invalid"].as_array().unwrap();
    assert!(invalid.len() >= 5);
    for case in invalid {
        let input = case["input"].as_str().unwrap();
        let want = reason_text(case["reason"].as_str().unwrap());
        match SyncKey::parse(input) {
            Ok(_) => panic!("invalid key accepted: {input:?}"),
            Err(e) => assert!(e.to_string().contains(want), "{input:?}: got {e}, want {want}"),
        }
    }
}

#[test]
fn xchacha_known_answers() {
    let kat = read_json("xchacha-kat.json");
    let vectors = kat["vectors"].as_array().unwrap();
    assert_eq!(vectors.len(), 2);
    for v in vectors {
        let field = |k: &str| unhex(v[k].as_str().unwrap());
        let sealed = seal(&field("keyHex"), &field("nonceHex"), &field("aadHex"), &field("plaintextHex"));
        assert_eq!(hex(&sealed), v["sealedHex"].as_str().unwrap(), "{}", v["name"]);
        assert_eq!(
            format!("{}{}", v["ciphertextHex"].as_str().unwrap(), v["tagHex"].as_str().unwrap()),
            v["sealedHex"].as_str().unwrap()
        );
        let opened = XChaCha20Poly1305::new_from_slice(&field("keyHex"))
            .unwrap()
            .decrypt(
                XNonce::from_slice(&field("nonceHex")),
                Payload { msg: &sealed, aad: &field("aadHex") },
            )
            .unwrap();
        assert_eq!(opened, field("plaintextHex"));
    }
    assert_eq!(vectors[0]["sealedHex"].as_str().unwrap(), format!("{DRAFT_CT}{DRAFT_TAG}"));

    // The Cardo vector also opens through the production SyncCipher.
    let v = &vectors[1];
    let (_, data_key) = fixture_key();
    assert_eq!(v["keyHex"].as_str().unwrap(), hex(&data_key));
    let blob = unhex(v["blobHex"].as_str().unwrap());
    assert_eq!(b64_decode(v["blobB64"].as_str().unwrap()), blob);
    let op_id = v["aadUtf8"].as_str().unwrap();
    let opened = SyncCipher::new(&data_key).decrypt(op_id, &blob).unwrap();
    assert_eq!(opened, unhex(v["plaintextHex"].as_str().unwrap()));
    let op: SyncOp = serde_json::from_slice(&opened).unwrap();
    assert_eq!(op.op_id, op_id);
    // Wrong AAD must fail.
    assert!(SyncCipher::new(&data_key).decrypt("other-op", &blob).is_err());
}

#[test]
fn notes_hash_vectors() {
    let notes = read_json("notes-hash.json");
    let cases = notes["cases"].as_array().unwrap();
    assert!(cases.len() >= 5);
    for case in cases {
        let text = case["text"].as_str().unwrap();
        assert_eq!(hex(text.as_bytes()), case["utf8Hex"].as_str().unwrap());
        assert_eq!(sha256_hex(text), case["sha256"].as_str().unwrap(), "{}", case["name"]);
    }
    // Anchors independent of this file's own generator.
    assert_eq!(sha256_hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert_eq!(sha256_hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
}

fn hub_dir() -> PathBuf {
    fixtures_dir().join("rust-hub")
}

/// Batch files of the committed hub, sorted (= pull order).
fn hub_batches(hub: &Path) -> Vec<(String, Value)> {
    let mut names: Vec<String> = std::fs::read_dir(hub.join("ops"))
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
        .into_iter()
        .map(|name| {
            assert!(name.ends_with(".cardo-ops") && !name.starts_with('.'), "stray file {name}");
            let raw = std::fs::read(hub.join("ops").join(&name)).unwrap();
            (name, serde_json::from_slice(&raw).unwrap())
        })
        .collect()
}

#[test]
fn rust_hub_blobs_decrypt_to_plaintext_json_bytes() {
    let (_, data_key) = fixture_key();
    let cipher = SyncCipher::new(&data_key);
    let plaintext: Vec<SyncOp> = serde_json::from_value(read_json("rust-hub/plaintext.json")).unwrap();
    let batches = hub_batches(&hub_dir());
    assert!(batches.len() >= 3, "expected one batch file per writer phase");

    let mut i = 0;
    for (name, batch) in &batches {
        // File name: <ms:013>-<uuid v4>.cardo-ops
        let stem = name.trim_end_matches(".cardo-ops");
        assert_eq!(stem.as_bytes()[13], b'-', "{name}");
        assert!(stem[..13].bytes().all(|b| b.is_ascii_digit()), "{name}");
        assert_eq!(batch["version"], 1);
        for wire in batch["ops"].as_array().unwrap() {
            let op_id = wire["op_id"].as_str().unwrap();
            let blob = b64_decode(wire["blob_b64"].as_str().unwrap());
            let bytes = cipher.decrypt(op_id, &blob).unwrap();
            let expected = &plaintext[i];
            assert_eq!(op_id, expected.op_id);
            // Byte-exact: the blob holds serde_json::to_vec(SyncOp).
            assert_eq!(
                String::from_utf8(bytes).unwrap(),
                serde_json::to_string(expected).unwrap(),
                "op #{i} in {name}"
            );
            i += 1;
        }
    }
    assert_eq!(i, plaintext.len(), "hub and plaintext.json disagree on op count");
}

#[tokio::test]
async fn rust_hub_replays_into_fresh_storage() {
    let (_, data_key) = fixture_key();
    // Work on a copy: verification must never write into the fixtures.
    let tmp = TempDir::new().unwrap();
    let hub = tmp.path().join("hub");
    std::fs::create_dir_all(hub.join("ops")).unwrap();
    for (name, _) in hub_batches(&hub_dir()) {
        std::fs::copy(hub_dir().join("ops").join(&name), hub.join("ops").join(&name)).unwrap();
    }
    let plaintext = read_json("rust-hub/plaintext.json");
    let op_count = plaintext.as_array().unwrap().len();

    let s = SqliteStorage::open(&tmp.path().join("reader.db")).await.unwrap();
    let transport = FolderTransport::new(&hub).unwrap();
    let report = SyncEngine::new(&s, &data_key, "fixture-reader").pull_once(&transport).await.unwrap();
    assert_eq!(report.pulled, op_count);
    assert_eq!(report.undecryptable, 0);
    assert_eq!(report.applied, op_count, "single-writer history: every op must win");
    assert_eq!(s.dump_all().await.unwrap(), read_json("rust-hub/expected-docs.json"));

    // Second pull is a no-op (cursor), full re-pull is idempotent.
    let again = SyncEngine::new(&s, &data_key, "fixture-reader").pull_once(&transport).await.unwrap();
    assert_eq!(again.pulled, 0);
    let reader = SyncEngine::new(&s, &data_key, "fixture-reader");
    reader.reset_cursor().await.unwrap();
    let re = reader.pull_once(&transport).await.unwrap();
    assert_eq!((re.pulled, re.applied, re.skipped), (op_count, 0, op_count));
    assert_eq!(s.dump_all().await.unwrap(), read_json("rust-hub/expected-docs.json"));
    // Nothing local to push: the reader produced no ops of its own.
    assert_eq!(s.unsynced_op_count().await.unwrap(), 0);

    // The notes doc carries a hash matching its content.
    let note = s.get("files.notes", "Grüße 🎉.md").await.unwrap().unwrap();
    assert_eq!(note["hash"].as_str().unwrap(), sha256_hex(note["content"].as_str().unwrap()));
}

#[tokio::test]
async fn rust_hub_rejects_wrong_key() {
    let tmp = TempDir::new().unwrap();
    let s = SqliteStorage::open(&tmp.path().join("eve.db")).await.unwrap();
    let wrong = SyncKey::generate().unwrap().derive();
    let hub = tmp.path().join("hub");
    std::fs::create_dir_all(hub.join("ops")).unwrap();
    for (name, _) in hub_batches(&hub_dir()) {
        std::fs::copy(hub_dir().join("ops").join(&name), hub.join("ops").join(&name)).unwrap();
    }
    let report = SyncEngine::new(&s, &wrong.data_key, "eve")
        .pull_once(&FolderTransport::new(&hub).unwrap())
        .await
        .unwrap();
    assert_eq!(report.applied, 0);
    assert_eq!(report.undecryptable, report.pulled);
    assert_eq!(s.dump_all().await.unwrap(), json!({}));
}
