use serde::Serialize;

use crate::error::{CoreError, Result};
use crate::storage::{ChangeNotice, ParkedOp, SqliteStorage, SyncOp};
use crate::sync::{EncryptedOp, SyncTransport};
use crate::sync_crypto::SyncCipher;
use crate::sync_cursor::LookbackCursor;

/// Bump whenever this build learns to apply ops it refused before (new op
/// kind, relaxed validator). Together with the crate version it forms the
/// park stamp: ops parked by a build with another stamp are retried.
pub const APPLY_VERSION: u32 = 1;

pub fn park_stamp() -> String {
    format!("rust-{}-apply-{APPLY_VERSION}", env!("CARGO_PKG_VERSION"))
}

/// Suffix of the sync_cursors row that holds the full look-back cursor. The
/// plain `transport_id` row keeps holding only the last filename: builds
/// from before the look-back cursor compare filenames against it with `>`,
/// and a JSON value there (`{` sorts after every digit) would silently stop
/// them from ever pulling again after a downgrade.
pub const CURSOR_KEY_SUFFIX: &str = "#lookback1";

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
    /// Blobs that failed to decrypt (wrong key / tampered) – surfaced, never
    /// fatal, dropped (not authentic).
    pub undecryptable: usize,
    /// Authentic ops (they decrypted) this build could not parse or apply –
    /// unknown op kind, invalid namespace / id / field, malformed JSON –
    /// e.g. from a newer or buggy client. PARKED (`sync_parked`), not
    /// dropped: a build with another park stamp retries them. Never fatal.
    pub rejected: usize,
    /// Parked ops of another build that this build could now apply or skip.
    pub unparked: usize,
    /// Hub batch files that could not be parsed (skipped, marked read).
    pub broken_files: usize,
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
        let stamp = park_stamp();
        // Ops a build with another stamp refused: retry once per build.
        for parked in self.storage.parked_ops(&stamp).await? {
            match self.apply_plaintext(&parked.payload).await? {
                Outcome::Refused(reason) => {
                    self.storage
                        .park_op(&ParkedOp { reason, stamp: stamp.clone(), ..parked })
                        .await?;
                }
                outcome => {
                    self.storage.unpark_op(&parked.op_id).await?;
                    report.unparked += 1;
                    match outcome {
                        Outcome::Applied(notice) => {
                            report.applied += 1;
                            report.notices.push(notice);
                        }
                        _ => report.skipped += 1,
                    }
                }
            }
        }

        let mut cursor = self.load_cursor().await?;
        loop {
            let batch = transport.pull(cursor.clone()).await?;
            report.pulled += batch.ops.len();
            report.broken_files += batch.broken_files;
            for op in &batch.ops {
                let plaintext = match self.cipher.decrypt(&op.op_id, &op.blob) {
                    Ok(bytes) => bytes,
                    Err(_) => {
                        report.undecryptable += 1;
                        continue;
                    }
                };
                match self.apply_plaintext(&plaintext).await? {
                    Outcome::Applied(notice) => {
                        report.applied += 1;
                        report.notices.push(notice);
                    }
                    Outcome::Skipped => report.skipped += 1,
                    Outcome::Refused(reason) => {
                        report.rejected += 1;
                        self.storage
                            .park_op(&ParkedOp {
                                op_id: op.op_id.clone(),
                                payload: plaintext,
                                reason,
                                stamp: stamp.clone(),
                            })
                            .await?;
                    }
                }
            }
            // The cursor is the only progress signal: an unchanged cursor
            // means the transport has nothing further – stop (also guards
            // against a transport that would otherwise make us spin).
            if batch.next_cursor == cursor {
                break;
            }
            cursor = batch.next_cursor;
            self.save_cursor(&cursor).await?;
        }
        Ok(())
    }

    /// Parses and applies one authentic plaintext. Store/IO errors propagate.
    async fn apply_plaintext(&self, plaintext: &[u8]) -> Result<Outcome> {
        let sync_op: SyncOp = match serde_json::from_slice(plaintext) {
            Ok(op) => op,
            Err(err) => return Ok(Outcome::Refused(format!("parse: {err}"))),
        };
        if self.exclude_namespaces.contains(&sync_op.namespace) {
            return Ok(Outcome::Skipped);
        }
        match self.storage.apply_remote_op(&sync_op).await {
            Ok(Some(notice)) => Ok(Outcome::Applied(notice)),
            Ok(None) => Ok(Outcome::Skipped),
            Err(err) if is_rejection(&err) => Ok(Outcome::Refused(err.to_string())),
            Err(err) => Err(err),
        }
    }

    fn cursor_key(&self) -> String {
        format!("{}{CURSOR_KEY_SUFFIX}", self.transport_id)
    }

    /// The full cursor; falls back to the legacy row once (plain filename
    /// from an older build, or JSON from a build before the split).
    async fn load_cursor(&self) -> Result<String> {
        let cursor = self.storage.cursor_get(&self.cursor_key()).await?;
        if !cursor.is_empty() {
            return Ok(cursor);
        }
        self.storage.cursor_get(&self.transport_id).await
    }

    async fn save_cursor(&self, cursor: &str) -> Result<()> {
        self.storage.cursor_set(&self.cursor_key(), cursor).await?;
        let legacy = LookbackCursor::parse(cursor).last;
        self.storage.cursor_set(&self.transport_id, &legacy).await
    }

    /// Forgets the pull position: the next round re-reads the whole hub
    /// (harmless – ops are deduplicated by id).
    pub async fn reset_cursor(&self) -> Result<()> {
        self.storage.cursor_set(&self.cursor_key(), "").await?;
        self.storage.cursor_set(&self.transport_id, "").await
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

enum Outcome {
    Applied(ChangeNotice),
    Skipped,
    /// Authentic but not applicable by this build – parked.
    Refused(String),
}

/// Validation errors that describe a bad (or too new) OP rather than a
/// broken database: those park the op. Everything else propagates.
fn is_rejection(err: &CoreError) -> bool {
    match err {
        CoreError::InvalidNamespace(_)
        | CoreError::InvalidField(_)
        | CoreError::InvalidId(_)
        | CoreError::InvalidOp(_)
        | CoreError::NotAnObject => true,
        CoreError::Db(_) | CoreError::Io(_) | CoreError::Serde(_) | CoreError::Other(_) => false,
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

        engine_b.reset_cursor().await.unwrap();
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

    /// A transport that keeps returning the same batch and cursor must not
    /// make the pull loop spin.
    #[tokio::test]
    async fn pull_loop_terminates_when_cursor_is_unchanged() {
        use crate::sync::{Cursor, PullBatch, PushAck};
        use std::sync::atomic::{AtomicUsize, Ordering};

        struct Stuck {
            calls: AtomicUsize,
        }
        #[async_trait::async_trait]
        impl SyncTransport for Stuck {
            async fn push(&self, ops: Vec<EncryptedOp>) -> Result<PushAck> {
                Ok(PushAck { accepted: ops.len() })
            }
            async fn pull(&self, since: Cursor) -> Result<PullBatch> {
                let n = self.calls.fetch_add(1, Ordering::SeqCst);
                assert!(n < 10, "pull loop is spinning");
                Ok(PullBatch {
                    ops: vec![EncryptedOp { op_id: "x".into(), blob: vec![0; 40] }],
                    next_cursor: since,
                    broken_files: 0,
                })
            }
        }

        let dir = TempDir::new().unwrap();
        let key = SyncKey::generate().unwrap().derive();
        let a = device(&dir, "a").await;
        let stuck = Stuck { calls: AtomicUsize::new(0) };
        let report = SyncEngine::new(&a, &key.data_key, "test").sync_once(&stuck).await.unwrap();
        assert_eq!(stuck.calls.load(Ordering::SeqCst), 1);
        assert_eq!(report.undecryptable, 1);
    }

    /// One op the storage refuses (invalid namespace) is counted as rejected;
    /// the rest of the round – including later valid ops – still applies,
    /// and the cursor moves past it.
    #[tokio::test]
    async fn invalid_op_does_not_block_the_round() {
        use crate::sync_crypto::SyncCipher;

        let dir = TempDir::new().unwrap();
        let hub = dir.path().join("hub");
        let key = SyncKey::generate().unwrap().derive();
        let transport = FolderTransport::new(&hub).unwrap();
        let cipher = SyncCipher::new(&key.data_key);

        let make = |op_id: &str, namespace: &str, doc_id: &str| {
            let op = SyncOp {
                op_id: op_id.into(),
                device_id: "00000000-0000-4000-8000-000000000001".into(),
                hlc: "1700000000000-0000-00000000-0000-4000-8000-000000000001".into(),
                namespace: namespace.into(),
                doc_id: doc_id.into(),
                op: "create".into(),
                field: None,
                value: Some(json!({"title":"ok"})),
                created_at: 1_700_000_000_000,
            };
            let plain = serde_json::to_vec(&op).unwrap();
            EncryptedOp { op_id: op_id.into(), blob: cipher.encrypt(op_id, &plain).unwrap() }
        };
        transport
            .push(vec![
                make("op-bad", "Bad Namespace!", "1"),
                make("op-bad-id", "todo", ""),
                make("op-good", "todo", "1"),
            ])
            .await
            .unwrap();

        let b = device(&dir, "b").await;
        let engine = SyncEngine::new(&b, &key.data_key, "test");
        let report = engine.sync_once(&transport).await.unwrap();
        assert_eq!(report.rejected, 2);
        assert_eq!(report.applied, 1);
        assert_eq!(b.get("todo", "1").await.unwrap().unwrap()["title"], "ok");

        // Refused ops are parked, not lost.
        assert_eq!(b.parked_op_count().await.unwrap(), 2);

        // Next round: cursor advanced, nothing re-read, parked ops are not
        // retried by the same build.
        let again = engine.sync_once(&transport).await.unwrap();
        assert_eq!(again.pulled, 0);
        assert_eq!(again.rejected, 0);
        assert_eq!(again.unparked, 0);
        assert_eq!(b.parked_op_count().await.unwrap(), 2);
    }

    fn sealed(cipher: &SyncCipher, op: &SyncOp) -> EncryptedOp {
        let plain = serde_json::to_vec(op).unwrap();
        EncryptedOp { op_id: op.op_id.clone(), blob: cipher.encrypt(&op.op_id, &plain).unwrap() }
    }

    /// An op kind this build does not know (a newer client) is parked with
    /// its plaintext; a later build (different stamp) applies it.
    #[tokio::test]
    async fn unknown_op_kind_is_parked_and_retried_by_a_later_build() {
        let dir = TempDir::new().unwrap();
        let hub = dir.path().join("hub");
        let key = SyncKey::generate().unwrap().derive();
        let transport = FolderTransport::new(&hub).unwrap();
        let cipher = SyncCipher::new(&key.data_key);
        let future = SyncOp {
            op_id: "op-future".into(),
            device_id: "00000000-0000-4000-8000-000000000001".into(),
            hlc: "1700000000000-0000-00000000-0000-4000-8000-000000000001".into(),
            namespace: "todo".into(),
            doc_id: "1".into(),
            op: "merge_text".into(),
            field: Some("t".into()),
            value: Some(json!("x")),
            created_at: 1,
        };
        transport.push(vec![sealed(&cipher, &future)]).await.unwrap();
        // Undecodable-but-authentic plaintext is parked too.
        transport
            .push(vec![EncryptedOp {
                op_id: "op-garbled".into(),
                blob: cipher.encrypt("op-garbled", br#"{"op_id":"op-garbled","created_at":1.0}"#).unwrap(),
            }])
            .await
            .unwrap();

        let b = device(&dir, "b").await;
        let engine = SyncEngine::new(&b, &key.data_key, "test");
        let report = engine.sync_once(&transport).await.unwrap();
        assert_eq!((report.rejected, report.undecryptable), (2, 0));
        let parked = b.parked_ops("another-build").await.unwrap();
        assert_eq!(parked.len(), 2);
        assert!(parked.iter().any(|p| p.op_id == "op-future" && p.reason.contains("unknown sync op")));

        // Simulate "a later build learned merge_text": the stored plaintext is
        // replaced by an applicable op and the stamp marks an older build.
        let learned = SyncOp { op: "set_field".into(), ..future };
        b.park_op(&ParkedOp {
            op_id: learned.op_id.clone(),
            payload: serde_json::to_vec(&learned).unwrap(),
            reason: "old".into(),
            stamp: "rust-0.0.0-apply-0".into(),
        })
        .await
        .unwrap();
        let later = engine.sync_once(&transport).await.unwrap();
        assert_eq!(later.unparked, 1);
        assert_eq!(later.applied, 1);
        assert_eq!(b.get("todo", "1").await.unwrap().unwrap(), json!({"t": "x"}));
        // The garbled one stays parked (same stamp, not retried).
        assert_eq!(b.parked_op_count().await.unwrap(), 1);
    }

    /// The legacy cursor row keeps a plain filename (older builds compare it
    /// with `>`); the full look-back cursor lives in its own row.
    #[tokio::test]
    async fn legacy_cursor_row_stays_a_plain_filename() {
        let dir = TempDir::new().unwrap();
        let hub = dir.path().join("hub");
        let key = SyncKey::generate().unwrap().derive();
        let transport = FolderTransport::new(&hub).unwrap();
        let a = device(&dir, "a").await;
        a.set("todo", "1", json!({"t": 1})).await.unwrap();
        SyncEngine::new(&a, &key.data_key, "w").sync_once(&transport).await.unwrap();

        let b = device(&dir, "b").await;
        // A cursor stored by a pre-split build (JSON in the legacy row) migrates.
        let engine = SyncEngine::new(&b, &key.data_key, "test");
        engine.sync_once(&transport).await.unwrap();
        let legacy = b.cursor_get("test").await.unwrap();
        assert!(legacy.ends_with(".cardo-ops") && !legacy.starts_with('{'), "{legacy}");
        let full = b.cursor_get(&format!("test{CURSOR_KEY_SUFFIX}")).await.unwrap();
        assert!(full.starts_with('{'));
        assert_eq!(LookbackCursor::parse(&full).last, legacy);
    }

    /// Broken hub files are counted in the report and do not block the round.
    #[tokio::test]
    async fn broken_batch_files_are_reported() {
        let dir = TempDir::new().unwrap();
        let hub = dir.path().join("hub");
        let key = SyncKey::generate().unwrap().derive();
        let transport = FolderTransport::new(&hub).unwrap();
        std::fs::write(hub.join("ops").join("0000000000001-x.cardo-ops"), b"not json").unwrap();
        let a = device(&dir, "a").await;
        a.set("todo", "1", json!({"t": 1})).await.unwrap();
        SyncEngine::new(&a, &key.data_key, "w").sync_once(&transport).await.unwrap();

        let b = device(&dir, "b").await;
        let report = SyncEngine::new(&b, &key.data_key, "test").sync_once(&transport).await.unwrap();
        assert_eq!(report.broken_files, 1);
        assert_eq!(report.applied, 1);
    }
}
