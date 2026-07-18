use serde::Serialize;

use crate::error::Result;
use crate::storage::{ChangeNotice, SqliteStorage, SyncOp};
use crate::sync::{EncryptedOp, SyncTransport};
use crate::sync_crypto::SyncCipher;

/// The device-agnostic sync loop: pull → decrypt → LWW-apply, then
/// drain the local change log → encrypt → push. Works against ANY
/// `SyncTransport`; the backend only ever sees `EncryptedOp` blobs.
pub struct SyncEngine<'a> {
    storage: &'a SqliteStorage,
    cipher: SyncCipher,
    /// Stable id for the cursor row, e.g. "folder:<path>" or "gdrive".
    transport_id: String,
    /// Namespaces that stay local (e.g. "core.layout" until opted in).
    exclude_namespaces: Vec<String>,
}

#[derive(Debug, Default, Serialize)]
pub struct SyncReport {
    /// Ops uploaded this round.
    pub pushed: usize,
    /// Ops downloaded this round (before dedupe/LWW).
    pub pulled: usize,
    /// Ops that actually changed a document.
    pub applied: usize,
    /// Duplicates, own echoes and LWW losers.
    pub skipped: usize,
    /// Blobs that failed to decrypt (wrong key / tampered) – surfaced, never fatal.
    pub undecryptable: usize,
    /// Document changes for UI refresh events.
    pub notices: Vec<ChangeNotice>,
}

const PUSH_BATCH: i64 = 500;

impl<'a> SyncEngine<'a> {
    pub fn new(storage: &'a SqliteStorage, data_key: &[u8; 32], transport_id: impl Into<String>) -> Self {
        Self {
            storage,
            cipher: SyncCipher::new(data_key),
            transport_id: transport_id.into(),
            exclude_namespaces: Vec::new(),
        }
    }

    /// Keeps whole namespaces off the wire in BOTH directions: local ops are
    /// not pushed (they stay pending until opted in) and remote ops for the
    /// namespace are recorded but not applied.
    pub fn with_excluded_namespaces(mut self, namespaces: Vec<String>) -> Self {
        self.exclude_namespaces = namespaces;
        self
    }

    /// One full round: pull-then-push (pulling first shrinks the conflict
    /// window). Both halves are idempotent – a crash between them only means
    /// some work happens again next round.
    pub async fn sync_once(&self, transport: &dyn SyncTransport) -> Result<SyncReport> {
        let mut report = SyncReport::default();
        self.pull_and_apply(transport, &mut report).await?;
        self.push_pending(transport, &mut report).await?;
        Ok(report)
    }

    /// Pull half only. Used by the app to check group policy (join allowed?
    /// device revoked?) BEFORE anything of this device reaches the hub.
    pub async fn pull_once(&self, transport: &dyn SyncTransport) -> Result<SyncReport> {
        let mut report = SyncReport::default();
        self.pull_and_apply(transport, &mut report).await?;
        Ok(report)
    }

    /// Push half only – the counterpart to `pull_once`.
    pub async fn push_once(&self, transport: &dyn SyncTransport) -> Result<SyncReport> {
        let mut report = SyncReport::default();
        self.push_pending(transport, &mut report).await?;
        Ok(report)
    }

    async fn pull_and_apply(
        &self,
        transport: &dyn SyncTransport,
        report: &mut SyncReport,
    ) -> Result<()> {
        let mut cursor = self.storage.cursor_get(&self.transport_id).await?;
        loop {
            let batch = transport.pull(cursor.clone()).await?;
            if batch.ops.is_empty() {
                break;
            }
            report.pulled += batch.ops.len();
            for op in &batch.ops {
                let plaintext = match self.cipher.decrypt(&op.op_id, &op.blob) {
                    Ok(bytes) => bytes,
                    Err(_) => {
                        report.undecryptable += 1;
                        continue;
                    }
                };
                let sync_op: SyncOp = match serde_json::from_slice(&plaintext) {
                    Ok(op) => op,
                    Err(_) => {
                        report.undecryptable += 1;
                        continue;
                    }
                };
                if self.exclude_namespaces.contains(&sync_op.namespace) {
                    report.skipped += 1;
                    continue;
                }
                match self.storage.apply_remote_op(&sync_op).await? {
                    Some(notice) => {
                        report.applied += 1;
                        report.notices.push(notice);
                    }
                    None => report.skipped += 1,
                }
            }
            if batch.next_cursor == cursor {
                break; // transport made no progress – avoid spinning
            }
            cursor = batch.next_cursor;
            self.storage.cursor_set(&self.transport_id, &cursor).await?;
        }
        Ok(())
    }

    async fn push_pending(
        &self,
        transport: &dyn SyncTransport,
        report: &mut SyncReport,
    ) -> Result<()> {
        loop {
            let pending = self.storage.unsynced_ops(PUSH_BATCH, &self.exclude_namespaces).await?;
            if pending.is_empty() {
                break;
            }
            let mut encrypted = Vec::with_capacity(pending.len());
            let mut ids = Vec::with_capacity(pending.len());
            for op in &pending {
                let plaintext = serde_json::to_vec(op)?;
                encrypted.push(EncryptedOp {
                    op_id: op.op_id.clone(),
                    blob: self.cipher.encrypt(&op.op_id, &plaintext)?,
                });
                ids.push(op.op_id.clone());
            }
            let count = encrypted.len();
            transport.push(encrypted).await?;
            // Only after the transport accepted the batch: never lose ops.
            self.storage.mark_ops_synced(&ids).await?;
            report.pushed += count;
            if count < PUSH_BATCH as usize {
                break;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::StorageAdapter;
    use crate::sync_folder::FolderTransport;
    use crate::sync_keys::SyncKey;
    use serde_json::json;
    use tempfile::TempDir;

    async fn device(dir: &TempDir, name: &str) -> SqliteStorage {
        SqliteStorage::open(&dir.path().join(format!("{name}.db"))).await.unwrap()
    }

    /// Two devices, one shared folder, one shared key: the full loop.
    #[tokio::test]
    async fn two_devices_converge_via_folder() {
        let dir = TempDir::new().unwrap();
        let hub = dir.path().join("hub");
        let key = SyncKey::generate().unwrap().derive();

        let a = device(&dir, "a").await;
        let b = device(&dir, "b").await;
        let transport = FolderTransport::new(&hub).unwrap();

        a.set("todo", "1", json!({"type":"task","title":"buy milk","done":false}))
            .await
            .unwrap();

        let engine_a = SyncEngine::new(&a, &key.data_key, "test");
        let engine_b = SyncEngine::new(&b, &key.data_key, "test");

        let ra = engine_a.sync_once(&transport).await.unwrap();
        assert!(ra.pushed >= 1);

        let rb = engine_b.sync_once(&transport).await.unwrap();
        assert!(rb.applied >= 1);
        let doc = b.get("todo", "1").await.unwrap().unwrap();
        assert_eq!(doc["title"], "buy milk");

        // B completes the task; A picks it up.
        b.set("todo", "1", json!({"type":"task","title":"buy milk","done":true}))
            .await
            .unwrap();
        engine_b.sync_once(&transport).await.unwrap();
        engine_a.sync_once(&transport).await.unwrap();
        let doc_a = a.get("todo", "1").await.unwrap().unwrap();
        assert_eq!(doc_a["done"], true);
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        needle.len() <= haystack.len() && haystack.windows(needle.len()).any(|w| w == needle)
    }

    /// SECURITY, end-to-end: the transport hub is exactly what a cloud backend
    /// (Google Drive `appDataFolder`, WebDAV, a synced folder) gets to see.
    /// This proves the zero-knowledge promise holds all the way to disk:
    ///   1. the plaintext a user typed never appears in any hub byte – not in
    ///      the raw batch file, not in the base64-decoded blob;
    ///   2. a device WITHOUT the key cannot read the data (all ops
    ///      undecryptable, nothing applied);
    ///   3. only a device WITH the key recovers the exact plaintext.
    #[tokio::test]
    async fn hub_leaks_no_plaintext_and_requires_the_key() {
        use crate::sync_folder::b64_decode;

        let dir = TempDir::new().unwrap();
        let hub = dir.path().join("hub");
        let key = SyncKey::generate().unwrap().derive();

        // A marker no cipher or base64 framing could produce by chance.
        const SECRET: &str = "TOP-SECRET-MARKER-3f9c1a8e2b7d4655-buy-insulin";

        let a = device(&dir, "a").await;
        a.set("notes", "n1", json!({ "type": "note", "title": SECRET, "body": SECRET }))
            .await
            .unwrap();

        let transport = FolderTransport::new(&hub).unwrap();
        let engine_a = SyncEngine::new(&a, &key.data_key, "test");
        assert!(engine_a.sync_once(&transport).await.unwrap().pushed >= 1);

        // 1) Scan every hub byte: raw file AND every base64-decoded blob.
        let secret = SECRET.as_bytes();
        let mut batch_files = 0;
        for entry in std::fs::read_dir(hub.join("ops")).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("cardo-ops") {
                continue;
            }
            batch_files += 1;
            let raw = std::fs::read(&path).unwrap();
            assert!(!contains(&raw, secret), "plaintext leaked into raw hub file {path:?}");
            let batch: serde_json::Value = serde_json::from_slice(&raw).unwrap();
            for op in batch["ops"].as_array().expect("ops array") {
                let blob = b64_decode(op["blob_b64"].as_str().expect("blob_b64")).expect("valid b64");
                assert!(!contains(&blob, secret), "plaintext leaked into a decoded blob in {path:?}");
            }
        }
        assert!(batch_files >= 1, "expected at least one batch file in the hub");

        // 2) Wrong key = no access: every op is undecryptable, nothing applied.
        let wrong = SyncKey::generate().unwrap().derive();
        let eve = device(&dir, "eve").await;
        let report = SyncEngine::new(&eve, &wrong.data_key, "test")
            .sync_once(&transport)
            .await
            .unwrap();
        assert_eq!(report.applied, 0, "wrong key must never apply an op");
        assert!(report.undecryptable >= 1, "wrong key must see the ops as undecryptable");
        assert!(eve.get("notes", "n1").await.unwrap().is_none(), "eve must learn nothing");

        // 3) Right key = exact recovery.
        let b = device(&dir, "b").await;
        assert!(SyncEngine::new(&b, &key.data_key, "test")
            .sync_once(&transport)
            .await
            .unwrap()
            .applied
            >= 1);
        let doc = b.get("notes", "n1").await.unwrap().unwrap();
        assert_eq!(doc["title"], SECRET);
        assert_eq!(doc["body"], SECRET);
    }

    /// Own pushes must not echo back as changes.
    #[tokio::test]
    async fn own_ops_do_not_echo() {
        let dir = TempDir::new().unwrap();
        let hub = dir.path().join("hub");
        let key = SyncKey::generate().unwrap().derive();
        let a = device(&dir, "a").await;
        let transport = FolderTransport::new(&hub).unwrap();
        let engine = SyncEngine::new(&a, &key.data_key, "test");

        a.set("notes", "n1", json!({"body":"hello"})).await.unwrap();
        engine.sync_once(&transport).await.unwrap();
        let second = engine.sync_once(&transport).await.unwrap();
        assert_eq!(second.applied, 0);
        assert_eq!(second.pushed, 0);
    }

    /// Sync is idempotent even when the cursor is lost (full re-pull).
    #[tokio::test]
    async fn re_pull_after_cursor_loss_changes_nothing() {
        let dir = TempDir::new().unwrap();
        let hub = dir.path().join("hub");
        let key = SyncKey::generate().unwrap().derive();
        let a = device(&dir, "a").await;
        let b = device(&dir, "b").await;
        let transport = FolderTransport::new(&hub).unwrap();
        let engine_a = SyncEngine::new(&a, &key.data_key, "test");
        let engine_b = SyncEngine::new(&b, &key.data_key, "test");

        a.set("todo", "1", json!({"title":"x"})).await.unwrap();
        engine_a.sync_once(&transport).await.unwrap();
        engine_b.sync_once(&transport).await.unwrap();

        b.cursor_set("test", "").await.unwrap();
        let report = engine_b.sync_once(&transport).await.unwrap();
        assert_eq!(report.applied, 0);
        assert!(report.skipped >= 1);
    }

    /// Concurrent edits to DIFFERENT fields merge; the same field resolves
    /// by hlc order – on both devices identically.
    #[tokio::test]
    async fn lww_per_field_converges() {
        let dir = TempDir::new().unwrap();
        let hub = dir.path().join("hub");
        let key = SyncKey::generate().unwrap().derive();
        let a = device(&dir, "a").await;
        let b = device(&dir, "b").await;
        let transport = FolderTransport::new(&hub).unwrap();
        let engine_a = SyncEngine::new(&a, &key.data_key, "test");
        let engine_b = SyncEngine::new(&b, &key.data_key, "test");

        // Seed both devices with the same doc.
        a.set("todo", "1", json!({"title":"orig","done":false})).await.unwrap();
        engine_a.sync_once(&transport).await.unwrap();
        engine_b.sync_once(&transport).await.unwrap();

        // Offline edits: A renames, B completes (different fields).
        a.set("todo", "1", json!({"title":"renamed","done":false})).await.unwrap();
        b.set("todo", "1", json!({"title":"orig","done":true})).await.unwrap();

        engine_a.sync_once(&transport).await.unwrap();
        engine_b.sync_once(&transport).await.unwrap();
        engine_a.sync_once(&transport).await.unwrap();
        engine_b.sync_once(&transport).await.unwrap();

        let doc_a = a.get("todo", "1").await.unwrap().unwrap();
        let doc_b = b.get("todo", "1").await.unwrap().unwrap();
        assert_eq!(doc_a, doc_b, "devices must converge");
        assert_eq!(doc_a["title"], "renamed");
        assert_eq!(doc_a["done"], true);
    }

    /// A delete with a newer hlc wins over an older edit – and vice versa.
    #[tokio::test]
    async fn delete_respects_lww() {
        let dir = TempDir::new().unwrap();
        let hub = dir.path().join("hub");
        let key = SyncKey::generate().unwrap().derive();
        let a = device(&dir, "a").await;
        let b = device(&dir, "b").await;
        let transport = FolderTransport::new(&hub).unwrap();
        let engine_a = SyncEngine::new(&a, &key.data_key, "test");
        let engine_b = SyncEngine::new(&b, &key.data_key, "test");

        a.set("todo", "1", json!({"title":"x"})).await.unwrap();
        engine_a.sync_once(&transport).await.unwrap();
        engine_b.sync_once(&transport).await.unwrap();

        // B deletes AFTER A's original write → delete wins everywhere.
        b.delete("todo", "1").await.unwrap();
        engine_b.sync_once(&transport).await.unwrap();
        engine_a.sync_once(&transport).await.unwrap();
        assert!(a.get("todo", "1").await.unwrap().is_none());
        assert!(b.get("todo", "1").await.unwrap().is_none());
    }

    /// A foreign (wrong-key) blob in the hub must not break the round.
    #[tokio::test]
    async fn wrong_key_blobs_are_skipped_not_fatal() {
        let dir = TempDir::new().unwrap();
        let hub = dir.path().join("hub");
        let key_a = SyncKey::generate().unwrap().derive();
        let key_b = SyncKey::generate().unwrap().derive();
        let a = device(&dir, "a").await;
        let b = device(&dir, "b").await;
        let transport = FolderTransport::new(&hub).unwrap();

        a.set("todo", "1", json!({"title":"secret"})).await.unwrap();
        SyncEngine::new(&a, &key_a.data_key, "test").sync_once(&transport).await.unwrap();

        let report = SyncEngine::new(&b, &key_b.data_key, "test")
            .sync_once(&transport)
            .await
            .unwrap();
        assert_eq!(report.applied, 0);
        assert!(report.undecryptable >= 1);
        assert!(b.get("todo", "1").await.unwrap().is_none());
    }
}
