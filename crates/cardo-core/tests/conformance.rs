//! Declarative storage / LWW conformance scenarios
//! (`tests/fixtures/sync-v1/conformance/*.json`), executed against the real
//! `SqliteStorage`. The TypeScript port runs the very same files against its
//! IndexedDB store – both must pass them all. Format: see the fixtures README.

mod common;

use cardo_core::storage::Query;
use cardo_core::{SqliteStorage, StorageAdapter, SyncOp};
use common::fixtures_dir;
use serde_json::{json, Value};

fn canonical(v: &Value) -> String {
    serde_json::to_string(v).unwrap()
}

fn same_rows(got: &[Value], want: &[Value], ordered: bool) -> bool {
    if ordered {
        return got == want;
    }
    let mut a: Vec<String> = got.iter().map(canonical).collect();
    let mut b: Vec<String> = want.iter().map(canonical).collect();
    a.sort();
    b.sort();
    a == b
}

fn str_of<'a>(step: &'a Value, key: &str) -> &'a str {
    step[key].as_str().unwrap_or_else(|| panic!("step needs string {key}: {step}"))
}

/// Runs one scenario; returns the list of mismatches (empty = pass).
async fn run_scenario(scenario: &Value) -> Vec<String> {
    let dir = tempfile::tempdir().unwrap();
    let s = SqliteStorage::open(&dir.path().join("conformance.db")).await.unwrap();
    let mut errors = Vec::new();

    for (i, step) in scenario["steps"].as_array().expect("steps").iter().enumerate() {
        let kind = str_of(step, "kind");
        let expect_error = step["expectError"].as_bool().unwrap_or(false);
        let mut fail = |msg: String| errors.push(format!("step {i} ({kind}): {msg}"));
        match kind {
            "set" => {
                let result = s.set(str_of(step, "namespace"), str_of(step, "id"), step["value"].clone()).await;
                match (result, expect_error) {
                    (Err(_), true) => {}
                    (Err(e), false) => fail(format!("unexpected error {e}")),
                    (Ok(n), true) => fail(format!("expected error, got {}", n.operation)),
                    (Ok(n), false) => {
                        if let Some(op) = step["expectOperation"].as_str() {
                            if n.operation != op {
                                fail(format!("operation {} != {op}", n.operation));
                            }
                        }
                        if let Some(c) = step["expectOpsLogged"].as_u64() {
                            if n.ops_logged as u64 != c {
                                fail(format!("opsLogged {} != {c}", n.ops_logged));
                            }
                        }
                    }
                }
            }
            "delete" => {
                let result = s.delete(str_of(step, "namespace"), str_of(step, "id")).await;
                match (result, expect_error) {
                    (Err(_), true) => {}
                    (Err(e), false) => fail(format!("unexpected error {e}")),
                    (Ok(_), true) => fail("expected error".into()),
                    (Ok(n), false) => {
                        if let Some(c) = step["expectOpsLogged"].as_u64() {
                            if n.ops_logged as u64 != c {
                                fail(format!("opsLogged {} != {c}", n.ops_logged));
                            }
                        }
                    }
                }
            }
            "get" => {
                let result = s.get(str_of(step, "namespace"), str_of(step, "id")).await;
                match (result, expect_error) {
                    (Err(_), true) => {}
                    (Err(e), false) => fail(format!("unexpected error {e}")),
                    (Ok(_), true) => fail("expected error".into()),
                    (Ok(doc), false) => {
                        let got = doc.unwrap_or(Value::Null);
                        if got != step["expectDoc"] {
                            fail(format!("doc {got} != {}", step["expectDoc"]));
                        }
                    }
                }
            }
            "remote" => {
                let op: SyncOp = serde_json::from_value(step["op"].clone())
                    .unwrap_or_else(|e| panic!("bad remote op in step {i}: {e}"));
                let want = str_of(step, "expect");
                let (got, operation) = match s.apply_remote_op(&op).await {
                    Ok(Some(n)) => ("applied", Some(n.operation)),
                    Ok(None) => ("skipped", None),
                    Err(_) => ("error", None),
                };
                if got != want {
                    fail(format!("op {} → {got}, expected {want}", op.op_id));
                } else if let Some(op_kind) = step["expectOperation"].as_str() {
                    if operation != Some(op_kind) {
                        fail(format!("notice operation {operation:?} != {op_kind}"));
                    }
                }
            }
            "query" => {
                let query: Query = serde_json::from_value(step["query"].clone())
                    .unwrap_or_else(|e| panic!("bad query in step {i}: {e}"));
                let ordered = step["ordered"].as_bool().unwrap_or(query.order_by.is_some());
                match (s.query(str_of(step, "namespace"), query).await, expect_error) {
                    (Err(_), true) => {}
                    (Err(e), false) => fail(format!("unexpected error {e}")),
                    (Ok(_), true) => fail("expected error".into()),
                    (Ok(rows), false) => {
                        let want = step["expectRows"].as_array().expect("expectRows");
                        if !same_rows(&rows, want, ordered) {
                            fail(format!("rows {} != {}", json!(rows), json!(want)));
                        }
                    }
                }
            }
            other => panic!("unknown step kind {other}"),
        }
    }

    let docs = s.dump_all().await.unwrap();
    if docs != scenario["expectDocs"] {
        errors.push(format!("expectDocs: got {docs}"));
    }

    // Every op this device wrote itself, in log order (remote winners are
    // stored with synced=1 and therefore not part of this list).
    let local: Vec<Value> = s
        .unsynced_ops(1_000_000, &[])
        .await
        .unwrap()
        .into_iter()
        .map(|op| {
            assert_eq!(op.device_id, s.device_id());
            json!({
                "namespace": op.namespace,
                "docId": op.doc_id,
                "op": op.op,
                "field": op.field,
                "value": op.value,
            })
        })
        .collect();
    if Value::Array(local.clone()) != scenario["expectLocalOps"] {
        errors.push(format!("expectLocalOps: got {}", json!(local)));
    }
    errors
}

#[tokio::test]
async fn conformance_scenarios_pass_against_sqlite_storage() {
    let dir = fixtures_dir().join("conformance");
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
        .collect();
    files.sort();
    assert!(files.len() >= 10, "expected the full scenario set, found {}", files.len());

    let mut failures = Vec::new();
    for path in &files {
        let scenario: Value = serde_json::from_slice(&std::fs::read(path).unwrap())
            .unwrap_or_else(|e| panic!("parse {path:?}: {e}"));
        let name = scenario["name"].as_str().unwrap_or("?").to_string();
        for err in run_scenario(&scenario).await {
            failures.push(format!("[{name}] {err}"));
        }
    }
    assert!(failures.is_empty(), "conformance failures:\n{}", failures.join("\n"));
}
