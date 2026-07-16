use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde::Serialize;
use serde_json::{Map, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{Pool, Row, Sqlite};
use uuid::Uuid;

use crate::error::{CoreError, Result};
use crate::hlc::Hlc;

/// Schema version of this build. The DB refuses to open if ITS version is
/// newer (downgrade protection after an update rollback).
pub const SCHEMA_VERSION: i64 = 3;

const MIGRATIONS: &[(i64, &str)] = &[
    (1, include_str!("../migrations/0001_init.sql")),
    (2, include_str!("../migrations/0002_schedules.sql")),
    (3, include_str!("../migrations/0003_sync.sql")),
];

/// One change-log row in wire shape: what sync serializes, encrypts and
/// applies. Field names are part of the sync protocol – do not rename.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct SyncOp {
    pub op_id: String,
    pub device_id: String,
    pub hlc: String,
    pub namespace: String,
    pub doc_id: String,
    pub op: String,
    pub field: Option<String>,
    pub value: Option<Value>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChangeNotice {
    pub namespace: String,
    #[serde(rename = "docId")]
    pub doc_id: String,
    pub operation: &'static str, // create | update | delete
    /// Number of change-log entries this write produced.
    pub ops_logged: usize,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct Query {
    #[serde(rename = "where", default)]
    pub where_: Vec<FieldFilter>,
    #[serde(rename = "orderBy")]
    pub order_by: Option<String>,
    pub direction: Option<String>, // asc | desc
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct FieldFilter {
    pub field: String,
    pub op: String, // = != < > <= >= like in
    pub value: Value,
}

#[async_trait]
pub trait StorageAdapter: Send + Sync {
    async fn get(&self, namespace: &str, id: &str) -> Result<Option<Value>>;
    /// Writes the document AND its change-log entries in one transaction.
    async fn set(&self, namespace: &str, id: &str, value: Value) -> Result<ChangeNotice>;
    async fn delete(&self, namespace: &str, id: &str) -> Result<ChangeNotice>;
    async fn query(&self, namespace: &str, q: Query) -> Result<Vec<Value>>;
}

pub struct SqliteStorage {
    pool: Pool<Sqlite>,
    hlc: Hlc,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn validate_namespace(ns: &str) -> Result<()> {
    let valid = !ns.is_empty()
        && ns.len() <= 64
        && ns.split('.').count() <= 2
        && ns.split('.').all(|part| {
            let mut chars = part.chars();
            matches!(chars.next(), Some('a'..='z'))
                && part.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        });
    if valid {
        Ok(())
    } else {
        Err(CoreError::InvalidNamespace(ns.to_string()))
    }
}

fn validate_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 128 || id.chars().any(|c| c.is_control()) {
        return Err(CoreError::InvalidId(id.to_string()));
    }
    Ok(())
}

fn validate_field(field: &str) -> Result<()> {
    let valid = !field.is_empty()
        && field.len() <= 64
        && field
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if valid {
        Ok(())
    } else {
        Err(CoreError::InvalidField(field.to_string()))
    }
}

impl SqliteStorage {
    /// Opens (and creates/migrates if necessary) the database at `path`.
    /// Before a migration of an existing file, a backup copy is written.
    pub async fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            // WAL permits only ONE writer at a time; with a multi-connection
            // pool, concurrent writes (e.g. several assistant proposals
            // executed in quick succession) would otherwise fail instantly
            // with SQLITE_BUSY ("database is locked"). A busy timeout makes a
            // blocked writer wait for the lock instead of erroring out.
            .busy_timeout(Duration::from_secs(5))
            .foreign_keys(true);
        // Single connection: SQLite allows only one writer, and set()/delete()
        // run a read-then-write transaction. With several pooled connections,
        // two such transactions could deadlock on the write-lock upgrade
        // (SQLITE_BUSY that a busy timeout can't resolve) — seen as intermittent
        // "database is locked" when assistant proposals fire in quick
        // succession. One connection serialises every op; for a local
        // single-user dashboard the throughput cost is irrelevant, and WAL
        // still keeps reads fast and writes crash-safe.
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;

        let current: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&pool)
            .await?;

        if current > SCHEMA_VERSION {
            return Err(CoreError::Other(format!(
                "database schema v{current} is newer than this app supports (v{SCHEMA_VERSION})"
            )));
        }

        if current < SCHEMA_VERSION {
            if current > 0 && path.exists() {
                let backup = path.with_extension(format!("db.bak-v{current}"));
                std::fs::copy(path, backup)?;
            }
            for (version, sql) in MIGRATIONS {
                if *version > current {
                    sqlx::raw_sql(sql).execute(&pool).await?;
                    sqlx::raw_sql(&format!("PRAGMA user_version = {version}"))
                        .execute(&pool)
                        .await?;
                }
            }
        }

        // Device id: created once, then stable for the lifetime of this install.
        let device_id: Option<String> =
            sqlx::query_scalar("SELECT value FROM meta WHERE key = 'device_id'")
                .fetch_optional(&pool)
                .await?;
        let device_id = match device_id {
            Some(id) => id,
            None => {
                let id = Uuid::new_v4().to_string();
                sqlx::query("INSERT INTO meta (key, value) VALUES ('device_id', ?)")
                    .bind(&id)
                    .execute(&pool)
                    .await?;
                sqlx::query("INSERT OR REPLACE INTO meta (key, value) VALUES ('created_at', ?)")
                    .bind(now_ms().to_string())
                    .execute(&pool)
                    .await?;
                id
            }
        };

        Ok(Self { pool, hlc: Hlc::new(device_id) })
    }

    pub fn device_id(&self) -> &str {
        self.hlc.device_id()
    }

    pub async fn schema_version(&self) -> Result<i64> {
        Ok(sqlx::query_scalar("PRAGMA user_version").fetch_one(&self.pool).await?)
    }

    /// Change-log entries for one document, oldest first (diagnostics/tests).
    pub async fn change_log_for(&self, namespace: &str, doc_id: &str) -> Result<Vec<Value>> {
        let rows = sqlx::query(
            "SELECT seq, op_id, device_id, hlc, op, field, value, created_at, synced
             FROM change_log WHERE namespace = ? AND doc_id = ? ORDER BY seq",
        )
        .bind(namespace)
        .bind(doc_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(serde_json::json!({
                    "seq": row.get::<i64, _>("seq"),
                    "opId": row.get::<String, _>("op_id"),
                    "deviceId": row.get::<String, _>("device_id"),
                    "hlc": row.get::<String, _>("hlc"),
                    "op": row.get::<String, _>("op"),
                    "field": row.get::<Option<String>, _>("field"),
                    "value": row
                        .get::<Option<String>, _>("value")
                        .map(|v| serde_json::from_str::<Value>(&v))
                        .transpose()?,
                    "createdAt": row.get::<i64, _>("created_at"),
                    "synced": row.get::<i64, _>("synced") != 0,
                }))
            })
            .collect()
    }

    pub async fn unsynced_op_count(&self) -> Result<i64> {
        Ok(
            sqlx::query_scalar("SELECT COUNT(*) FROM change_log WHERE synced = 0")
                .fetch_one(&self.pool)
                .await?,
        )
    }

    /* ── Persistent scheduler ─────────────────────────────────────────── */

    pub async fn schedule_set(
        &self,
        id: &str,
        fire_at_ms: i64,
        command_id: &str,
        params: &Value,
    ) -> Result<()> {
        sqlx::query(
            "INSERT OR REPLACE INTO schedules (id, fire_at, command_id, params, created_at)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(fire_at_ms)
        .bind(command_id)
        .bind(params.to_string())
        .bind(now_ms())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn schedule_cancel(&self, id: &str) -> Result<()> {
        sqlx::query("DELETE FROM schedules WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn schedule_list(&self) -> Result<Vec<Value>> {
        let rows = sqlx::query("SELECT id, fire_at, command_id, params FROM schedules ORDER BY fire_at")
            .fetch_all(&self.pool)
            .await?;
        rows.into_iter()
            .map(|row| {
                let params: Value =
                    serde_json::from_str(row.get::<String, _>("params").as_str())
                        .unwrap_or(Value::Null);
                Ok(serde_json::json!({
                    "id": row.get::<String, _>("id"),
                    "fireAt": row.get::<i64, _>("fire_at"),
                    "commandId": row.get::<String, _>("command_id"),
                    "params": params,
                }))
            })
            .collect()
    }

    /* ── Sync ─────────────────────────────────────────────────────────── */

    /// Unsynced local ops in log order, ready for encryption + push.
    /// `exclude` filters whole namespaces (e.g. "core.layout" while layout
    /// sync is opt-out); excluded ops stay unsynced and flow the moment the
    /// user enables that namespace.
    pub async fn unsynced_ops(&self, limit: i64, exclude: &[String]) -> Result<Vec<SyncOp>> {
        // Namespace names are validated on write; still, bind them instead
        // of interpolating values.
        let placeholders = std::iter::repeat_n("?", exclude.len()).collect::<Vec<_>>().join(", ");
        let sql = if exclude.is_empty() {
            "SELECT op_id, device_id, hlc, namespace, doc_id, op, field, value, created_at
             FROM change_log WHERE synced = 0 ORDER BY seq LIMIT ?"
                .to_string()
        } else {
            format!(
                "SELECT op_id, device_id, hlc, namespace, doc_id, op, field, value, created_at
                 FROM change_log WHERE synced = 0 AND namespace NOT IN ({placeholders})
                 ORDER BY seq LIMIT ?"
            )
        };
        let mut query = sqlx::query(&sql);
        for ns in exclude {
            query = query.bind(ns);
        }
        let rows = query.bind(limit).fetch_all(&self.pool).await?;
        rows.into_iter()
            .map(|row| {
                Ok(SyncOp {
                    op_id: row.get("op_id"),
                    device_id: row.get("device_id"),
                    hlc: row.get("hlc"),
                    namespace: row.get("namespace"),
                    doc_id: row.get("doc_id"),
                    op: row.get("op"),
                    field: row.get("field"),
                    value: row
                        .get::<Option<String>, _>("value")
                        .map(|raw| serde_json::from_str(&raw))
                        .transpose()?,
                    created_at: row.get("created_at"),
                })
            })
            .collect()
    }

    pub async fn mark_ops_synced(&self, op_ids: &[String]) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        for id in op_ids {
            sqlx::query("UPDATE change_log SET synced = 1 WHERE op_id = ?")
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// Op already in the local log (own echo) or applied earlier?
    pub async fn is_op_known(&self, op_id: &str) -> Result<bool> {
        let known: i64 = sqlx::query_scalar(
            "SELECT (SELECT COUNT(*) FROM change_log WHERE op_id = ?1)
                  + (SELECT COUNT(*) FROM sync_applied WHERE op_id = ?1)",
        )
        .bind(op_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(known > 0)
    }

    pub async fn cursor_get(&self, transport: &str) -> Result<String> {
        let cursor: Option<String> =
            sqlx::query_scalar("SELECT cursor FROM sync_cursors WHERE transport = ?")
                .bind(transport)
                .fetch_optional(&self.pool)
                .await?;
        Ok(cursor.unwrap_or_default())
    }

    pub async fn cursor_set(&self, transport: &str, cursor: &str) -> Result<()> {
        sqlx::query(
            "INSERT INTO sync_cursors (transport, cursor, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(transport) DO UPDATE SET cursor = excluded.cursor,
             updated_at = excluded.updated_at",
        )
        .bind(transport)
        .bind(cursor)
        .bind(now_ms())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Applies one remote op with last-writer-wins per field (doc-level ops
    /// dominate their document). Returns a notice when the document actually
    /// changed, None when the op was a duplicate or lost the LWW race.
    /// Idempotent: every op id is recorded either way.
    pub async fn apply_remote_op(&self, op: &SyncOp) -> Result<Option<ChangeNotice>> {
        validate_namespace(&op.namespace)?;
        validate_id(&op.doc_id)?;
        if self.is_op_known(&op.op_id).await? {
            return Ok(None);
        }

        let mut tx = self.pool.begin().await?;

        // Latest local knowledge this op competes against.
        let latest_local: Option<String> = match op.op.as_str() {
            "set_field" | "delete_field" => {
                let field = op.field.as_deref().unwrap_or_default();
                sqlx::query_scalar(
                    "SELECT MAX(hlc) FROM change_log
                     WHERE namespace = ? AND doc_id = ?
                       AND (field = ? OR op IN ('create', 'delete_doc'))",
                )
                .bind(&op.namespace)
                .bind(&op.doc_id)
                .bind(field)
                .fetch_one(&mut *tx)
                .await?
            }
            _ => {
                sqlx::query_scalar(
                    "SELECT MAX(hlc) FROM change_log WHERE namespace = ? AND doc_id = ?",
                )
                .bind(&op.namespace)
                .bind(&op.doc_id)
                .fetch_one(&mut *tx)
                .await?
            }
        };
        let remote_wins = latest_local.as_deref().is_none_or(|local| op.hlc.as_str() > local);

        let now = now_ms();
        let mut notice: Option<ChangeNotice> = None;

        if remote_wins {
            match op.op.as_str() {
                "create" => {
                    let value = op.value.clone().unwrap_or(Value::Object(Map::new()));
                    sqlx::query(
                        "INSERT INTO documents (namespace, id, data, created_at, updated_at, deleted)
                         VALUES (?, ?, ?, ?, ?, 0)
                         ON CONFLICT(namespace, id) DO UPDATE
                         SET data = excluded.data, updated_at = excluded.updated_at, deleted = 0",
                    )
                    .bind(&op.namespace)
                    .bind(&op.doc_id)
                    .bind(value.to_string())
                    .bind(now)
                    .bind(now)
                    .execute(&mut *tx)
                    .await?;
                    notice = Some(ChangeNotice {
                        namespace: op.namespace.clone(),
                        doc_id: op.doc_id.clone(),
                        operation: "create",
                        ops_logged: 1,
                    });
                }
                "set_field" | "delete_field" => {
                    let field = op
                        .field
                        .clone()
                        .ok_or_else(|| CoreError::Other("field op without field".into()))?;
                    validate_field(&field)?;
                    let existing: Option<String> = sqlx::query_scalar(
                        "SELECT data FROM documents WHERE namespace = ? AND id = ?",
                    )
                    .bind(&op.namespace)
                    .bind(&op.doc_id)
                    .fetch_optional(&mut *tx)
                    .await?;
                    let mut doc: Map<String, Value> = existing
                        .as_deref()
                        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                        .and_then(|v| v.as_object().cloned())
                        .unwrap_or_default();
                    if op.op == "set_field" {
                        doc.insert(field, op.value.clone().unwrap_or(Value::Null));
                    } else {
                        doc.remove(&field);
                    }
                    sqlx::query(
                        "INSERT INTO documents (namespace, id, data, created_at, updated_at, deleted)
                         VALUES (?, ?, ?, ?, ?, 0)
                         ON CONFLICT(namespace, id) DO UPDATE
                         SET data = excluded.data, updated_at = excluded.updated_at, deleted = 0",
                    )
                    .bind(&op.namespace)
                    .bind(&op.doc_id)
                    .bind(Value::Object(doc).to_string())
                    .bind(now)
                    .bind(now)
                    .execute(&mut *tx)
                    .await?;
                    notice = Some(ChangeNotice {
                        namespace: op.namespace.clone(),
                        doc_id: op.doc_id.clone(),
                        operation: "update",
                        ops_logged: 1,
                    });
                }
                "delete_doc" => {
                    sqlx::query(
                        "UPDATE documents SET deleted = 1, updated_at = ?
                         WHERE namespace = ? AND id = ?",
                    )
                    .bind(now)
                    .bind(&op.namespace)
                    .bind(&op.doc_id)
                    .execute(&mut *tx)
                    .await?;
                    notice = Some(ChangeNotice {
                        namespace: op.namespace.clone(),
                        doc_id: op.doc_id.clone(),
                        operation: "delete",
                        ops_logged: 1,
                    });
                }
                other => {
                    return Err(CoreError::Other(format!("unknown sync op \"{other}\"")));
                }
            }

            // Winning remote ops join the log (synced=1: already on the wire)
            // so future LWW lookups see the remote hlc.
            sqlx::query(
                "INSERT INTO change_log (op_id, device_id, hlc, namespace, doc_id, op, field, value, created_at, synced)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
            )
            .bind(&op.op_id)
            .bind(&op.device_id)
            .bind(&op.hlc)
            .bind(&op.namespace)
            .bind(&op.doc_id)
            .bind(&op.op)
            .bind(op.field.as_deref())
            .bind(op.value.as_ref().map(|v| v.to_string()))
            .bind(op.created_at)
            .execute(&mut *tx)
            .await?;
        }

        // Losers and winners alike are remembered – a pull is idempotent.
        sqlx::query("INSERT OR IGNORE INTO sync_applied (op_id, applied_at) VALUES (?, ?)")
            .bind(&op.op_id)
            .bind(now)
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;
        Ok(notice)
    }

    /// Live document ids of one namespace (sync file-lane discovery).
    pub async fn list_ids(&self, namespace: &str) -> Result<Vec<String>> {
        validate_namespace(namespace)?;
        let rows: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM documents WHERE namespace = ? AND deleted = 0 ORDER BY id",
        )
        .bind(namespace)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    /* ── Backup ───────────────────────────────────────────────────────── */

    /// Full dump of every live document, grouped by namespace.
    pub async fn dump_all(&self) -> Result<Value> {
        let rows =
            sqlx::query("SELECT namespace, id, data FROM documents WHERE deleted = 0 ORDER BY namespace, id")
                .fetch_all(&self.pool)
                .await?;
        let mut out = serde_json::Map::new();
        for row in rows {
            let ns = row.get::<String, _>("namespace");
            let id = row.get::<String, _>("id");
            let data: Value = serde_json::from_str(row.get::<String, _>("data").as_str())
                .unwrap_or(Value::Null);
            out.entry(ns)
                .or_insert_with(|| Value::Object(serde_json::Map::new()))
                .as_object_mut()
                .expect("namespace entry is an object")
                .insert(id, data);
        }
        Ok(Value::Object(out))
    }

    async fn log_op(
        tx: &mut sqlx::Transaction<'_, Sqlite>,
        hlc: &Hlc,
        namespace: &str,
        doc_id: &str,
        op: &str,
        field: Option<&str>,
        value: Option<&Value>,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO change_log (op_id, device_id, hlc, namespace, doc_id, op, field, value, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(Uuid::now_v7().to_string())
        .bind(hlc.device_id())
        .bind(hlc.now())
        .bind(namespace)
        .bind(doc_id)
        .bind(op)
        .bind(field)
        .bind(value.map(|v| v.to_string()))
        .bind(now_ms())
        .execute(&mut **tx)
        .await?;
        Ok(())
    }
}

#[async_trait]
impl StorageAdapter for SqliteStorage {
    async fn get(&self, namespace: &str, id: &str) -> Result<Option<Value>> {
        validate_namespace(namespace)?;
        validate_id(id)?;
        let row: Option<String> = sqlx::query_scalar(
            "SELECT data FROM documents WHERE namespace = ? AND id = ? AND deleted = 0",
        )
        .bind(namespace)
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|data| serde_json::from_str(&data)).transpose()?)
    }

    async fn set(&self, namespace: &str, id: &str, value: Value) -> Result<ChangeNotice> {
        validate_namespace(namespace)?;
        validate_id(id)?;
        let new_obj: &Map<String, Value> = value.as_object().ok_or(CoreError::NotAnObject)?;

        let mut tx = self.pool.begin().await?;
        let existing: Option<(String, i64)> = sqlx::query(
            "SELECT data, deleted FROM documents WHERE namespace = ? AND id = ?",
        )
        .bind(namespace)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .map(|row| (row.get::<String, _>("data"), row.get::<i64, _>("deleted")));

        let now = now_ms();
        let mut ops_logged = 0usize;

        let operation = match existing {
            None | Some((_, 1)) => {
                sqlx::query(
                    "INSERT INTO documents (namespace, id, data, created_at, updated_at, deleted)
                     VALUES (?, ?, ?, ?, ?, 0)
                     ON CONFLICT(namespace, id) DO UPDATE
                     SET data = excluded.data, updated_at = excluded.updated_at, deleted = 0",
                )
                .bind(namespace)
                .bind(id)
                .bind(value.to_string())
                .bind(now)
                .bind(now)
                .execute(&mut *tx)
                .await?;
                Self::log_op(&mut tx, &self.hlc, namespace, id, "create", None, Some(&value))
                    .await?;
                ops_logged += 1;
                "create"
            }
            Some((old_data, _)) => {
                let old: Value = serde_json::from_str(&old_data)?;
                let empty = Map::new();
                let old_obj = old.as_object().unwrap_or(&empty);

                // Field-level diff on top level → one log entry per changed field.
                // This granularity IS the basis for last-writer-wins per field.
                let mut changed = false;
                for (key, new_val) in new_obj {
                    if old_obj.get(key) != Some(new_val) {
                        Self::log_op(
                            &mut tx, &self.hlc, namespace, id, "set_field",
                            Some(key), Some(new_val),
                        )
                        .await?;
                        ops_logged += 1;
                        changed = true;
                    }
                }
                for key in old_obj.keys() {
                    if !new_obj.contains_key(key) {
                        Self::log_op(
                            &mut tx, &self.hlc, namespace, id, "delete_field", Some(key), None,
                        )
                        .await?;
                        ops_logged += 1;
                        changed = true;
                    }
                }
                if changed {
                    sqlx::query(
                        "UPDATE documents SET data = ?, updated_at = ? WHERE namespace = ? AND id = ?",
                    )
                    .bind(value.to_string())
                    .bind(now)
                    .bind(namespace)
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
                }
                "update"
            }
        };

        tx.commit().await?;
        Ok(ChangeNotice {
            namespace: namespace.to_string(),
            doc_id: id.to_string(),
            operation,
            ops_logged,
        })
    }

    async fn delete(&self, namespace: &str, id: &str) -> Result<ChangeNotice> {
        validate_namespace(namespace)?;
        validate_id(id)?;
        let mut tx = self.pool.begin().await?;
        let affected = sqlx::query(
            "UPDATE documents SET deleted = 1, updated_at = ? WHERE namespace = ? AND id = ? AND deleted = 0",
        )
        .bind(now_ms())
        .bind(namespace)
        .bind(id)
        .execute(&mut *tx)
        .await?
        .rows_affected();

        let mut ops_logged = 0usize;
        if affected > 0 {
            // Tombstone, not a hard delete: sync needs to propagate deletions.
            Self::log_op(&mut tx, &self.hlc, namespace, id, "delete_doc", None, None).await?;
            ops_logged += 1;
        }
        tx.commit().await?;
        Ok(ChangeNotice {
            namespace: namespace.to_string(),
            doc_id: id.to_string(),
            operation: "delete",
            ops_logged,
        })
    }

    async fn query(&self, namespace: &str, q: Query) -> Result<Vec<Value>> {
        validate_namespace(namespace)?;

        let mut sql = String::from(
            "SELECT data FROM documents WHERE namespace = ? AND deleted = 0",
        );
        for filter in &q.where_ {
            validate_field(&filter.field)?;
            let clause = match filter.op.as_str() {
                "=" => "=",
                "!=" => "!=",
                "<" => "<",
                ">" => ">",
                "<=" => "<=",
                ">=" => ">=",
                "like" => "LIKE",
                "in" => "IN",
                other => return Err(CoreError::Other(format!("unsupported query op: {other}"))),
            };
            if clause == "IN" {
                sql.push_str(&format!(
                    " AND json_extract(data, '$.{}') IN (SELECT value FROM json_each(?))",
                    filter.field
                ));
            } else if clause == "LIKE" {
                sql.push_str(&format!(
                    " AND json_extract(data, '$.{}') LIKE '%' || ? || '%'",
                    filter.field
                ));
            } else {
                sql.push_str(&format!(
                    " AND json_extract(data, '$.{}') {clause} ?",
                    filter.field
                ));
            }
        }
        if let Some(order_by) = &q.order_by {
            validate_field(order_by)?;
            let dir = match q.direction.as_deref() {
                Some("desc") => "DESC",
                _ => "ASC",
            };
            sql.push_str(&format!(" ORDER BY json_extract(data, '$.{order_by}') {dir}"));
        }
        if q.limit.is_some() {
            sql.push_str(" LIMIT ?");
        }

        let mut query = sqlx::query_scalar::<_, String>(&sql).bind(namespace);
        for filter in &q.where_ {
            query = match &filter.value {
                Value::Number(n) if n.is_i64() => query.bind(n.as_i64()),
                Value::Number(n) => query.bind(n.as_f64()),
                Value::Bool(b) => query.bind(*b),
                Value::String(s) if filter.op != "in" => query.bind(s.clone()),
                v => query.bind(v.to_string()),
            };
        }
        if let Some(limit) = q.limit {
            query = query.bind(limit);
        }

        let rows = query.fetch_all(&self.pool).await?;
        rows.into_iter()
            .map(|data| Ok(serde_json::from_str(&data)?))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn open_temp() -> (SqliteStorage, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let storage = SqliteStorage::open(&dir.path().join("test.db")).await.unwrap();
        (storage, dir)
    }

    #[tokio::test]
    async fn roundtrip_and_namespacing() {
        let (s, _dir) = open_temp().await;
        s.set("todo", "1", json!({"title": "hello", "done": false})).await.unwrap();
        assert_eq!(
            s.get("todo", "1").await.unwrap().unwrap()["title"],
            json!("hello")
        );
        assert!(s.get("notes", "1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn every_write_hits_the_change_log() {
        let (s, _dir) = open_temp().await;
        let n1 = s.set("todo", "1", json!({"title": "a", "prio": 1})).await.unwrap();
        assert_eq!((n1.operation, n1.ops_logged), ("create", 1));

        // Update touching ONE field → exactly one set_field op.
        let n2 = s.set("todo", "1", json!({"title": "b", "prio": 1})).await.unwrap();
        assert_eq!((n2.operation, n2.ops_logged), ("update", 1));

        // Removing a field → delete_field op.
        let n3 = s.set("todo", "1", json!({"title": "b"})).await.unwrap();
        assert_eq!(n3.ops_logged, 1);

        // No-op write → nothing logged.
        let n4 = s.set("todo", "1", json!({"title": "b"})).await.unwrap();
        assert_eq!(n4.ops_logged, 0);

        let log = s.change_log_for("todo", "1").await.unwrap();
        assert_eq!(log.len(), 3);
        assert_eq!(log[0]["op"], "create");
        assert_eq!(log[1]["op"], "set_field");
        assert_eq!(log[1]["field"], "title");
        assert_eq!(log[2]["op"], "delete_field");
        assert_eq!(log[2]["field"], "prio");
        // HLC timestamps sort in write order.
        assert!(log[0]["hlc"].as_str().unwrap() < log[1]["hlc"].as_str().unwrap());
        assert_eq!(s.unsynced_op_count().await.unwrap(), 3);
    }

    #[tokio::test]
    async fn delete_is_a_tombstone() {
        let (s, _dir) = open_temp().await;
        s.set("todo", "1", json!({"title": "x"})).await.unwrap();
        let n = s.delete("todo", "1").await.unwrap();
        assert_eq!(n.ops_logged, 1);
        assert!(s.get("todo", "1").await.unwrap().is_none());
        let log = s.change_log_for("todo", "1").await.unwrap();
        assert_eq!(log.last().unwrap()["op"], "delete_doc");
        // Re-creating after delete works and logs a create.
        let n2 = s.set("todo", "1", json!({"title": "again"})).await.unwrap();
        assert_eq!(n2.operation, "create");
    }

    #[tokio::test]
    async fn concurrent_writes_all_succeed() {
        // Regression: several assistant proposals executed in quick succession
        // fire concurrent set()s on the multi-connection WAL pool. Without a
        // busy timeout the loser of the write lock failed with SQLITE_BUSY
        // ("database is locked"); with it, every write waits and succeeds.
        let (s, _dir) = open_temp().await;
        let s = std::sync::Arc::new(s);
        let mut handles = Vec::new();
        for i in 0..16 {
            let s = std::sync::Arc::clone(&s);
            handles.push(tokio::spawn(async move {
                s.set("todo", &format!("task:{i}"), json!({ "title": format!("t{i}") })).await
            }));
        }
        for h in handles {
            h.await.unwrap().expect("concurrent write must not fail with SQLITE_BUSY");
        }
        let all = s
            .query("todo", Query {
                where_: vec![],
                order_by: None,
                direction: None,
                limit: None,
            })
            .await
            .unwrap();
        assert_eq!(all.len(), 16, "every concurrent write must be persisted");
    }

    #[tokio::test]
    async fn query_filters_orders_limits() {
        let (s, _dir) = open_temp().await;
        s.set("todo", "1", json!({"p": 3, "done": false, "title": "write plan"})).await.unwrap();
        s.set("todo", "2", json!({"p": 1, "done": true, "title": "old task"})).await.unwrap();
        s.set("todo", "3", json!({"p": 2, "done": false, "title": "plan more"})).await.unwrap();

        let open = s
            .query("todo", Query {
                where_: vec![FieldFilter { field: "done".into(), op: "=".into(), value: json!(false) }],
                order_by: Some("p".into()),
                direction: Some("desc".into()),
                limit: None,
            })
            .await
            .unwrap();
        assert_eq!(open.iter().map(|d| d["p"].as_i64().unwrap()).collect::<Vec<_>>(), vec![3, 2]);

        let like = s
            .query("todo", Query {
                where_: vec![FieldFilter { field: "title".into(), op: "like".into(), value: json!("plan") }],
                order_by: None, direction: None, limit: Some(1),
            })
            .await
            .unwrap();
        assert_eq!(like.len(), 1);
    }

    #[tokio::test]
    async fn rejects_bad_input() {
        let (s, _dir) = open_temp().await;
        assert!(s.set("../evil", "1", json!({})).await.is_err());
        assert!(s.set("todo", "1", json!("not an object")).await.is_err());
        assert!(s
            .query("todo", Query {
                where_: vec![FieldFilter { field: "p'); DROP TABLE".into(), op: "=".into(), value: json!(1) }],
                ..Default::default()
            })
            .await
            .is_err());
    }

    #[tokio::test]
    async fn persists_across_reopen_with_stable_device_id() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("persist.db");
        let device_id;
        {
            let s = SqliteStorage::open(&path).await.unwrap();
            device_id = s.device_id().to_string();
            s.set("core.layout", "page-1", json!({"widgets": []})).await.unwrap();
        }
        let s = SqliteStorage::open(&path).await.unwrap();
        assert_eq!(s.device_id(), device_id);
        assert!(s.get("core.layout", "page-1").await.unwrap().is_some());
        assert_eq!(s.schema_version().await.unwrap(), SCHEMA_VERSION);
    }
}
