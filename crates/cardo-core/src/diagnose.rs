use serde::Serialize;
use serde_json::json;

use crate::storage::{Query, SqliteStorage, StorageAdapter, SCHEMA_VERSION};

/// Rust-side self-test checks. They run against a SCRATCH database in a
/// temporary directory – real user data is never touched. The TS layer
/// merges these results into the full diagnose report.
#[derive(Debug, Clone, Serialize)]
pub struct CoreCheckResult {
    pub id: String,
    pub status: String, // pass | warn | fail
    pub detail: Option<String>,
}

fn pass(id: &str) -> CoreCheckResult {
    CoreCheckResult { id: id.into(), status: "pass".into(), detail: None }
}

fn fail(id: &str, detail: impl Into<String>) -> CoreCheckResult {
    CoreCheckResult { id: id.into(), status: "fail".into(), detail: Some(detail.into()) }
}

pub async fn run_core_checks(app_data_dir: &std::path::Path) -> Vec<CoreCheckResult> {
    let mut results = Vec::new();

    // 1. App data dir writable?
    let probe = app_data_dir.join(".cardo-write-probe");
    match std::fs::write(&probe, b"ok").and_then(|_| std::fs::remove_file(&probe)) {
        Ok(_) => results.push(pass("core:storage-path")),
        Err(e) => {
            results.push(fail("core:storage-path", e.to_string()));
            return results; // nothing else can work without a writable dir
        }
    }

    // 2..4. Scratch DB: read/write roundtrip, change log, migration state.
    let scratch_dir = match tempfile::TempDir::new_in(app_data_dir) {
        Ok(d) => d,
        Err(e) => {
            results.push(fail("core:db-read-write", format!("scratch dir: {e}")));
            return results;
        }
    };
    let db_path = scratch_dir.path().join("diagnose-scratch.db");

    let storage = match SqliteStorage::open(&db_path).await {
        Ok(s) => s,
        Err(e) => {
            results.push(fail("core:db-read-write", e.to_string()));
            return results;
        }
    };

    // Roundtrip
    let write = storage.set("diagnose", "probe", json!({"n": 42, "s": "ok"})).await;
    let read = storage.get("diagnose", "probe").await;
    match (write, read) {
        (Ok(_), Ok(Some(doc))) if doc["n"] == json!(42) => results.push(pass("core:db-read-write")),
        (w, r) => results.push(fail("core:db-read-write", format!("write={w:?} read={r:?}"))),
    }

    // Change log records the write?
    match storage.change_log_for("diagnose", "probe").await {
        Ok(log) if !log.is_empty() && log[0]["op"] == json!("create") => {
            results.push(pass("core:change-log"))
        }
        Ok(log) => results.push(fail("core:change-log", format!("unexpected log: {log:?}"))),
        Err(e) => results.push(fail("core:change-log", e.to_string())),
    }

    // Query path works?
    match storage
        .query("diagnose", Query {
            where_: vec![crate::storage::FieldFilter {
                field: "n".into(),
                op: "=".into(),
                value: json!(42),
            }],
            ..Default::default()
        })
        .await
    {
        Ok(rows) if rows.len() == 1 => results.push(pass("core:db-query")),
        Ok(rows) => results.push(fail("core:db-query", format!("expected 1 row, got {}", rows.len()))),
        Err(e) => results.push(fail("core:db-query", e.to_string())),
    }

    // Migration state
    match storage.schema_version().await {
        Ok(v) if v == SCHEMA_VERSION => results.push(pass("core:migrations")),
        Ok(v) => results.push(fail("core:migrations", format!("schema v{v}, expected v{SCHEMA_VERSION}"))),
        Err(e) => results.push(fail("core:migrations", e.to_string())),
    }

    // Sync crypto: key generate → derive → seal/open roundtrip, tamper check.
    results.push(match sync_crypto_check() {
        Ok(()) => pass("core:sync-crypto"),
        Err(e) => fail("core:sync-crypto", e),
    });

    // Sync engine: full two-store roundtrip over a scratch folder transport.
    results.push(match sync_engine_check(scratch_dir.path()).await {
        Ok(()) => pass("core:sync-engine"),
        Err(e) => fail("core:sync-engine", e),
    });

    results
}

fn sync_crypto_check() -> Result<(), String> {
    let key = crate::SyncKey::generate().map_err(|e| e.to_string())?;
    let display = key.display();
    let parsed = crate::SyncKey::parse(&display).map_err(|e| format!("reparse: {e}"))?;
    let derived = parsed.derive();
    let cipher = crate::sync_crypto::SyncCipher::new(&derived.data_key);
    let blob = cipher.encrypt("probe", b"diagnose").map_err(|e| e.to_string())?;
    let plain = cipher.decrypt("probe", &blob).map_err(|e| e.to_string())?;
    if plain != b"diagnose" {
        return Err("decrypt returned different plaintext".into());
    }
    let mut tampered = blob;
    if let Some(last) = tampered.last_mut() {
        *last ^= 1;
    }
    if cipher.decrypt("probe", &tampered).is_ok() {
        return Err("tampered blob decrypted – AEAD broken".into());
    }
    Ok(())
}

async fn sync_engine_check(scratch: &std::path::Path) -> Result<(), String> {
    let key = crate::SyncKey::generate().map_err(|e| e.to_string())?.derive();
    let a = SqliteStorage::open(&scratch.join("sync-a.db")).await.map_err(|e| e.to_string())?;
    let b = SqliteStorage::open(&scratch.join("sync-b.db")).await.map_err(|e| e.to_string())?;
    let hub = crate::FolderTransport::new(scratch.join("sync-hub")).map_err(|e| e.to_string())?;

    a.set("diagnose", "sync-probe", json!({"n": 7}))
        .await
        .map_err(|e| e.to_string())?;
    crate::SyncEngine::new(&a, &key.data_key, "diag")
        .sync_once(&hub)
        .await
        .map_err(|e| format!("push: {e}"))?;
    crate::SyncEngine::new(&b, &key.data_key, "diag")
        .sync_once(&hub)
        .await
        .map_err(|e| format!("pull: {e}"))?;
    match b.get("diagnose", "sync-probe").await.map_err(|e| e.to_string())? {
        Some(doc) if doc["n"] == json!(7) => Ok(()),
        other => Err(format!("device B did not converge: {other:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn all_core_checks_pass_in_a_healthy_environment() {
        let dir = tempfile::tempdir().unwrap();
        let results = run_core_checks(dir.path()).await;
        assert_eq!(results.len(), 7);
        for r in &results {
            assert_eq!(r.status, "pass", "check {} failed: {:?}", r.id, r.detail);
        }
    }
}
