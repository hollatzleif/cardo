//! TS → Rust interop: `tests/fixtures/sync-v1/ts-hub` was written by the
//! TypeScript port (`packages/sync`, IndexedDB store + SyncEngine + folder
//! hub) running the same scripted sequence as `write_rust_hub` in
//! `sync_vectors.rs`. A fresh `SqliteStorage` must pull it unchanged.
//!
//! Regenerate (from the repo root):
//! `CARDO_WRITE_VECTORS=1 pnpm vitest run packages/sync -t "writes the ts-hub"`

mod common;

use std::path::{Path, PathBuf};

use cardo_core::sync_crypto::SyncCipher;
use cardo_core::{FolderTransport, SqliteStorage, StorageAdapter, SyncEngine, SyncOp};
use common::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tempfile::TempDir;

/// Same struct layout as `BatchFile`/`WireOp` in sync_folder.rs (field order matters).
#[derive(Serialize, Deserialize)]
struct BatchFile {
    version: u32,
    ops: Vec<WireOp>,
}

#[derive(Serialize, Deserialize)]
struct WireOp {
    op_id: String,
    blob_b64: String,
}

fn ts_hub() -> PathBuf {
    fixtures_dir().join("ts-hub")
}

/// Batch files of the committed hub in pull order (name order).
fn batches(hub: &Path) -> Vec<(String, Value)> {
    let mut names: Vec<String> = std::fs::read_dir(hub.join("ops"))
        .unwrap_or_else(|e| panic!("{hub:?}/ops missing ({e}); regenerate the ts-hub fixture"))
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
fn ts_hub_blobs_are_serde_canonical_sync_ops() {
    let (_, data_key) = fixture_key();
    let cipher = SyncCipher::new(&data_key);
    let plaintext: Vec<SyncOp> = serde_json::from_value(read_json("ts-hub/plaintext.json")).unwrap();
    let files = batches(&ts_hub());
    assert!(files.len() >= 3, "expected one batch file per writer phase");

    let mut i = 0;
    for (name, batch) in &files {
        let stem = name.trim_end_matches(".cardo-ops");
        assert_eq!(stem.len(), 13 + 1 + 36, "{name}");
        assert_eq!(stem.as_bytes()[13], b'-', "{name}");
        assert!(stem[..13].bytes().all(|b| b.is_ascii_digit()), "{name}");
        assert_eq!(uuid::Uuid::parse_str(&stem[14..]).unwrap().get_version_num(), 4, "{name}");
        assert_eq!(batch["version"], 1);
        // The TS batch file is byte-identical to what serde writes for it.
        let raw = String::from_utf8(std::fs::read(ts_hub().join("ops").join(name)).unwrap()).unwrap();
        let typed: BatchFile = serde_json::from_str(&raw).unwrap();
        assert_eq!(raw, serde_json::to_string(&typed).unwrap(), "{name}");
        for wire in batch["ops"].as_array().unwrap() {
            let op_id = wire["op_id"].as_str().unwrap();
            let bytes = cipher.decrypt(op_id, &b64_decode(wire["blob_b64"].as_str().unwrap())).unwrap();
            let text = String::from_utf8(bytes).unwrap();
            let op: SyncOp = serde_json::from_str(&text).unwrap();
            assert_eq!(op.op_id, op_id);
            assert_eq!(uuid::Uuid::parse_str(op_id).unwrap().get_version_num(), 7, "op_id must be UUIDv7");
            assert_eq!(uuid::Uuid::parse_str(&op.device_id).unwrap().get_version_num(), 4);
            // Byte-exact: the TS encoder writes what serde_json::to_vec(SyncOp) writes.
            assert_eq!(text, serde_json::to_string(&op).unwrap(), "op #{i} in {name}");
            assert_eq!(text, serde_json::to_string(&plaintext[i]).unwrap(), "op #{i} vs plaintext.json");
            // hlc = <ms:013>-<counter:04>-<device_id>
            let (ms, rest) = op.hlc.split_at(13);
            assert!(ms.bytes().all(|b| b.is_ascii_digit()), "{}", op.hlc);
            assert_eq!(&rest[..1], "-");
            assert!(rest[1..5].bytes().all(|b| b.is_ascii_digit()), "{}", op.hlc);
            assert_eq!(&rest[5..], format!("-{}", op.device_id), "{}", op.hlc);
            i += 1;
        }
    }
    assert_eq!(i, plaintext.len(), "hub and plaintext.json disagree on op count");
}

#[tokio::test]
async fn ts_hub_replays_into_fresh_sqlite_storage() {
    let (_, data_key) = fixture_key();
    let tmp = TempDir::new().unwrap();
    let hub = tmp.path().join("hub");
    std::fs::create_dir_all(hub.join("ops")).unwrap();
    for (name, _) in batches(&ts_hub()) {
        std::fs::copy(ts_hub().join("ops").join(&name), hub.join("ops").join(&name)).unwrap();
    }
    let op_count = read_json("ts-hub/plaintext.json").as_array().unwrap().len();
    let expected = read_json("ts-hub/expected-docs.json");

    let s = SqliteStorage::open(&tmp.path().join("reader.db")).await.unwrap();
    let transport = FolderTransport::new(&hub).unwrap();
    let report = SyncEngine::new(&s, &data_key, "ts-reader").pull_once(&transport).await.unwrap();
    assert_eq!(report.pulled, op_count);
    assert_eq!(report.undecryptable, 0);
    assert_eq!(report.applied, op_count, "single-writer history: every op must win");
    assert_eq!(s.dump_all().await.unwrap(), expected);

    // The TS writer replayed the Rust writer's script: same documents, except
    // that JS cannot tell `1.0` from `1` (the contact's `ratio`).
    let mut rust_docs = read_json("rust-hub/expected-docs.json");
    let contact = &mut rust_docs["contacts"]["Jürgen Müller–Lüdenscheidt"];
    assert_eq!(contact["ratio"].to_string(), "1.0");
    contact["ratio"] = Value::from(1);
    assert_eq!(expected, rust_docs, "ts-hub and rust-hub scripts diverged");

    // Idempotent: cursor stops a second pull, a full re-pull skips everything.
    let again = SyncEngine::new(&s, &data_key, "ts-reader").pull_once(&transport).await.unwrap();
    assert_eq!(again.pulled, 0);
    let reader = SyncEngine::new(&s, &data_key, "ts-reader");
    reader.reset_cursor().await.unwrap();
    let re = reader.pull_once(&transport).await.unwrap();
    assert_eq!((re.pulled, re.applied, re.skipped), (op_count, 0, op_count));
    assert_eq!(s.dump_all().await.unwrap(), expected);
    assert_eq!(s.unsynced_op_count().await.unwrap(), 0);

    let note = s.get("files.notes", "Grüße 🎉.md").await.unwrap().unwrap();
    let content = note["content"].as_str().unwrap();
    assert_eq!(note["hash"].as_str().unwrap(), hex(&Sha256::digest(content.as_bytes())));
}
