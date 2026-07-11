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

    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn all_core_checks_pass_in_a_healthy_environment() {
        let dir = tempfile::tempdir().unwrap();
        let results = run_core_checks(dir.path()).await;
        assert_eq!(results.len(), 5);
        for r in &results {
            assert_eq!(r.status, "pass", "check {} failed: {:?}", r.id, r.detail);
        }
    }
}
