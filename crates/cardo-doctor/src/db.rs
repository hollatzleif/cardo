//! Read-only inspection of the LIVE database.
//!
//! ⚠️ This module must never call `cardo_core::SqliteStorage::open`. That
//! function creates the file if missing, copies a backup, runs migrations and
//! **writes `PRAGMA user_version`**. Running it from a diagnostic tool would
//! mutate the user's real data — and worse, could migrate a database while the
//! app has it open. Everything here goes through `read_only(true)` +
//! `create_if_missing(false)`.

use std::path::Path;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::Row;

/// What the live database looks like from the outside.
#[derive(Debug, Clone)]
pub struct DbFacts {
    pub schema_version: i64,
    pub size_bytes: u64,
    /// `PRAGMA quick_check` result; "ok" when the file is structurally sound.
    pub integrity: String,
    /// Size of the `-wal` sidecar, if present.
    pub wal_bytes: Option<u64>,
    /// Names of `cardo.db.bak-v*` files sitting next to the database.
    pub backups: Vec<String>,
}

/// Inspect the database without touching it.
pub async fn inspect(db: &Path) -> Result<DbFacts, String> {
    if !db.is_file() {
        return Err(format!("{} does not exist", db.display()));
    }
    let size_bytes = std::fs::metadata(db).map(|m| m.len()).unwrap_or(0);

    let options = SqliteConnectOptions::new()
        .filename(db)
        .read_only(true)
        .create_if_missing(false);

    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|e| format!("open read-only: {e}"))?;

    let schema_version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&pool)
        .await
        .map_err(|e| format!("user_version: {e}"))?;

    // `quick_check` over `integrity_check`: same structural guarantees for a
    // fraction of the cost on an 11 MB file, and it does not need a write lock.
    let integrity: String = sqlx::query("PRAGMA quick_check")
        .fetch_one(&pool)
        .await
        .map_err(|e| format!("quick_check: {e}"))?
        .try_get(0)
        .map_err(|e| format!("quick_check result: {e}"))?;

    pool.close().await;

    let wal_bytes = std::fs::metadata(wal_path(db)).ok().map(|m| m.len());
    let backups = backup_files(db);

    Ok(DbFacts { schema_version, size_bytes, integrity, wal_bytes, backups })
}

fn wal_path(db: &Path) -> std::path::PathBuf {
    let mut name = db.as_os_str().to_os_string();
    name.push("-wal");
    std::path::PathBuf::from(name)
}

/// `cardo.db.bak-v1`, `cardo.db.bak-v2`, … written by the migration path.
fn backup_files(db: &Path) -> Vec<String> {
    let Some(dir) = db.parent() else { return Vec::new() };
    let Some(stem) = db.file_name().and_then(|n| n.to_str()) else { return Vec::new() };
    let prefix = format!("{stem}.bak-v");
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut found: Vec<String> = entries
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.starts_with(&prefix))
        .collect();
    found.sort();
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn missing_file_is_an_error_not_a_created_database() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("cardo.db");
        assert!(inspect(&db).await.is_err());
        // The decisive assertion: inspecting must not bring the file into
        // existence. `create_if_missing(false)` is what guarantees this.
        assert!(!db.exists(), "inspect() created a database file");
    }

    #[tokio::test]
    async fn reports_schema_version_without_migrating() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("cardo.db");

        // Build a v1 database by hand, then prove inspect() leaves it at v1
        // instead of migrating it up to SCHEMA_VERSION.
        let setup = SqliteConnectOptions::new().filename(&db).create_if_missing(true);
        let pool = SqlitePoolOptions::new().connect_with(setup).await.unwrap();
        sqlx::raw_sql("PRAGMA user_version = 1").execute(&pool).await.unwrap();
        pool.close().await;

        let facts = inspect(&db).await.unwrap();
        assert_eq!(facts.schema_version, 1);
        assert_eq!(facts.integrity, "ok");
        assert!(facts.size_bytes > 0);

        // Re-open and confirm nothing was written.
        let facts_again = inspect(&db).await.unwrap();
        assert_eq!(facts_again.schema_version, 1, "inspect() migrated the database");
    }

    #[tokio::test]
    async fn finds_migration_backups() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("cardo.db");
        std::fs::write(&db, b"").unwrap();
        std::fs::write(dir.path().join("cardo.db.bak-v2"), b"").unwrap();
        std::fs::write(dir.path().join("cardo.db.bak-v1"), b"").unwrap();
        std::fs::write(dir.path().join("unrelated.txt"), b"").unwrap();

        assert_eq!(backup_files(&db), vec!["cardo.db.bak-v1", "cardo.db.bak-v2"]);
    }
}
