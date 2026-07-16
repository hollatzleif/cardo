//! Sync file lane: notes (.md files) and assistant documents (personality,
//! instructions, memory, competences) travel as ordinary encrypted ops.
//!
//! Mechanics: file contents mirror into DB documents (`files.notes` /
//! `files.assistant`) whose changes flow through the existing change-log →
//! encrypt → transport pipeline. Per-file base hashes live in a LOCAL
//! (never-synced) `sync-filestate.json`; three-way comparison against them
//! detects local edits, remote edits and conflicts.
//!
//! Conflict policy: notes get a conflict COPY (Obsidian pattern — user
//! content never silently lost); assistant docs resolve last-writer-wins
//! (they are small, regenerable configuration texts).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use cardo_core::{SqliteStorage, StorageAdapter};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const NOTES_NS: &str = "files.notes";
const ASSISTANT_NS: &str = "files.assistant";
const STATE_FILE: &str = "sync-filestate.json";
/// Notes are text — anything huge is not ours to carry.
const MAX_FILE_BYTES: u64 = 512 * 1024;

type BaseHashes = HashMap<String, String>;

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct FileState {
    #[serde(default)]
    notes: BaseHashes,
    #[serde(default)]
    assistant: BaseHashes,
}

fn state_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(STATE_FILE)
}

fn load_state(app_data_dir: &Path) -> FileState {
    std::fs::read(state_path(app_data_dir))
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default()
}

fn save_state(app_data_dir: &Path, state: &FileState) -> Result<(), String> {
    let raw = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
    std::fs::write(state_path(app_data_dir), raw).map_err(|e| e.to_string())
}

fn content_hash(content: &str) -> String {
    let digest = Sha256::digest(content.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Report of one lane sweep (surfaced through the sync report/UI later).
#[derive(Default, Debug)]
pub struct FileLaneReport {
    pub pushed: usize,
    pub applied: usize,
    pub conflicts: usize,
}

/// One synced file as the DB sees it.
fn doc_value(content: &str) -> Value {
    json!({ "content": content, "hash": content_hash(content) })
}

/// Lists the sync-relevant files of a directory tree as (docId, absolute
/// path) pairs. `flat` = top-level *.md only (notes); otherwise a recursive
/// walk of text documents (assistant store layout).
fn list_files(root: &Path, flat: bool) -> Vec<(String, PathBuf)> {
    fn walk(dir: &Path, root: &Path, flat: bool, out: &mut Vec<(String, PathBuf)>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue; // hidden files, .cardo-sync hubs, editor droppings
            }
            if meta.is_dir() {
                if !flat {
                    walk(&path, root, flat, out);
                }
                continue;
            }
            if meta.len() > MAX_FILE_BYTES {
                continue;
            }
            let is_text = name.ends_with(".md") || name.ends_with(".txt");
            if !is_text {
                continue;
            }
            let Ok(rel) = path.strip_prefix(root) else { continue };
            let doc_id = rel.to_string_lossy().replace('\\', "/");
            if doc_id.len() > 128 || doc_id.contains("..") {
                continue;
            }
            out.push((doc_id, path));
        }
    }
    let mut out = Vec::new();
    walk(root, root, flat, &mut out);
    out.sort();
    out
}

fn safe_join(root: &Path, doc_id: &str) -> Option<PathBuf> {
    if doc_id.is_empty()
        || doc_id.len() > 128
        || doc_id.contains("..")
        || doc_id.starts_with('/')
        || doc_id.starts_with('.')
        || doc_id.contains('\\')
        || doc_id.chars().any(char::is_control)
    {
        return None;
    }
    Some(root.join(doc_id))
}

/// Conflict copy name: "todo.md" → "todo (Konflikt MacBook 2026-07-16).md".
fn conflict_name(doc_id: &str, device_label: &str) -> String {
    let date = {
        // Local date without pulling in chrono: seconds → days since epoch is
        // fine for a filename suffix; collisions just append " 2".
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let days = secs / 86_400;
        format!("d{days}")
    };
    match doc_id.rsplit_once('.') {
        Some((stem, ext)) => format!("{stem} (Konflikt {device_label} {date}).{ext}"),
        None => format!("{doc_id} (Konflikt {device_label} {date})"),
    }
}

struct Lane<'a> {
    namespace: &'a str,
    root: PathBuf,
    flat: bool,
    /// true → conflict copies; false → last-writer-wins (remote applies).
    conflict_copies: bool,
}

async fn sweep_lane(
    storage: &SqliteStorage,
    lane: &Lane<'_>,
    base: &mut BaseHashes,
    device_label: &str,
    report: &mut FileLaneReport,
) -> Result<(), String> {
    // The DB side of this lane (docs arrived via pull-apply). query() strips
    // ids, so discovery goes through list_ids + per-doc get.
    let db_ids = storage.list_ids(lane.namespace).await.map_err(|e| e.to_string())?;

    let local_files = list_files(&lane.root, lane.flat);
    let mut local: HashMap<String, String> = HashMap::new(); // docId → content
    for (doc_id, path) in &local_files {
        if let Ok(content) = std::fs::read_to_string(path) {
            local.insert(doc_id.clone(), content);
        }
    }

    // Union of every docId we have to reason about.
    let mut ids: Vec<String> = local.keys().chain(base.keys()).cloned().collect();
    ids.extend(db_ids);
    ids.sort();
    ids.dedup();

    for doc_id in ids {
        let local_content = local.get(&doc_id);
        let local_hash = local_content.map(|c| content_hash(c));
        let base_hash = base.get(&doc_id).cloned();
        let db_entry: Option<(String, String)> = storage
            .get(lane.namespace, &doc_id)
            .await
            .map_err(|e| e.to_string())?
            .and_then(|doc| {
                let content = doc["content"].as_str()?.to_string();
                let hash = doc["hash"].as_str()?.to_string();
                Some((content, hash))
            });

        match (local_hash.as_deref(), base_hash.as_deref(), db_entry) {
            // ── Remote is ahead of our base ────────────────────────────
            (local_h, base_h, Some((db_content, db_hash))) if Some(db_hash.as_str()) != base_h => {
                let Some(target) = safe_join(&lane.root, &doc_id) else { continue };
                if local_h == Some(db_hash.as_str()) {
                    // Local already matches remote → just settle the base.
                    base.insert(doc_id.clone(), db_hash);
                    continue;
                }
                let local_diverged = matches!((local_h, base_h), (Some(l), Some(b)) if l != b)
                    || (local_h.is_some() && base_h.is_none());
                if local_diverged && lane.conflict_copies {
                    // Both sides changed: preserve the local text as a copy…
                    if let (Some(content), Some(copy_path)) = (
                        local_content,
                        safe_join(&lane.root, &conflict_name(&doc_id, device_label)),
                    ) {
                        let _ = std::fs::write(copy_path, content);
                        report.conflicts += 1;
                    }
                }
                // …then the remote version wins the original name (LWW for
                // assistant docs, post-copy apply for notes).
                if let Some(parent) = target.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                std::fs::write(&target, &db_content).map_err(|e| e.to_string())?;
                base.insert(doc_id.clone(), db_hash);
                report.applied += 1;
            }
            // ── Remote doc gone, we knew it → local delete (notes only) ─
            (Some(_), Some(_), None) if base_hash.is_some() => {
                // Doc vanished remotely. Only delete when local is unchanged
                // against base; otherwise re-push local below next round.
                if local_hash.as_deref() == base_hash.as_deref() {
                    if let Some(target) = safe_join(&lane.root, &doc_id) {
                        let _ = std::fs::remove_file(target);
                    }
                    base.remove(&doc_id);
                } else {
                    // Local changed → resurrect as a fresh push.
                    if let Some(content) = local_content {
                        storage
                            .set(lane.namespace, &doc_id, doc_value(content))
                            .await
                            .map_err(|e| e.to_string())?;
                        base.insert(doc_id.clone(), content_hash(content));
                        report.pushed += 1;
                    }
                }
            }
            // ── Local new or changed → push ────────────────────────────
            (Some(local_h), base_h, _) if Some(local_h) != base_h => {
                if let Some(content) = local_content {
                    storage
                        .set(lane.namespace, &doc_id, doc_value(content))
                        .await
                        .map_err(|e| e.to_string())?;
                    base.insert(doc_id.clone(), local_h.to_string());
                    report.pushed += 1;
                }
            }
            // ── Local file deleted → delete the doc ────────────────────
            (None, Some(_), Some(_)) => {
                storage
                    .delete(lane.namespace, &doc_id)
                    .await
                    .map_err(|e| e.to_string())?;
                base.remove(&doc_id);
                report.pushed += 1;
            }
            // Base entry with neither local nor remote left: forget it.
            (None, Some(_), None) => {
                base.remove(&doc_id);
            }
            _ => {}
        }
    }
    Ok(())
}

/// Runs both lanes. Called from `run_sync_round` between pull-apply and
/// push, so remote file docs are already in the DB and freshly mirrored
/// local changes still make this round's upload.
pub async fn sweep(
    storage: &SqliteStorage,
    app_data_dir: &Path,
    notes_dir: Option<PathBuf>,
    assistant_dir: Option<PathBuf>,
    device_label: &str,
) -> Result<FileLaneReport, String> {
    let mut state = load_state(app_data_dir);
    let mut report = FileLaneReport::default();

    if let Some(root) = notes_dir {
        if root.is_dir() {
            let lane = Lane { namespace: NOTES_NS, root, flat: true, conflict_copies: true };
            sweep_lane(storage, &lane, &mut state.notes, device_label, &mut report).await?;
        }
    }
    if let Some(root) = assistant_dir {
        if root.is_dir() {
            let lane =
                Lane { namespace: ASSISTANT_NS, root, flat: false, conflict_copies: false };
            sweep_lane(storage, &lane, &mut state.assistant, device_label, &mut report).await?;
        }
    }

    save_state(app_data_dir, &state)?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn storage(dir: &TempDir) -> SqliteStorage {
        SqliteStorage::open(&dir.path().join("t.db")).await.unwrap()
    }

    #[tokio::test]
    async fn local_files_push_and_remote_docs_materialize() {
        let dir = TempDir::new().unwrap();
        let notes = dir.path().join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        std::fs::write(notes.join("a.md"), "hello").unwrap();
        let s = storage(&dir).await;

        // Round 1: local file becomes a doc.
        let report = sweep(&s, dir.path(), Some(notes.clone()), None, "dev").await.unwrap();
        assert_eq!(report.pushed, 1);
        let doc = s.get("files.notes", "a.md").await.unwrap().unwrap();
        assert_eq!(doc["content"], "hello");

        // Remote edit lands in the DB (as pull-apply would) → file updates.
        s.set("files.notes", "a.md", doc_value("hello from afar")).await.unwrap();
        let report = sweep(&s, dir.path(), Some(notes.clone()), None, "dev").await.unwrap();
        assert_eq!(report.applied, 1);
        assert_eq!(std::fs::read_to_string(notes.join("a.md")).unwrap(), "hello from afar");
    }

    #[tokio::test]
    async fn conflicting_edits_keep_a_copy() {
        let dir = TempDir::new().unwrap();
        let notes = dir.path().join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        std::fs::write(notes.join("n.md"), "base").unwrap();
        let s = storage(&dir).await;
        sweep(&s, dir.path(), Some(notes.clone()), None, "dev").await.unwrap();

        // Both sides move on independently.
        std::fs::write(notes.join("n.md"), "local edit").unwrap();
        s.set("files.notes", "n.md", doc_value("remote edit")).await.unwrap();
        let report = sweep(&s, dir.path(), Some(notes.clone()), None, "dev").await.unwrap();
        assert_eq!(report.conflicts, 1);

        // Remote wins the original, local text survives as a copy.
        assert_eq!(std::fs::read_to_string(notes.join("n.md")).unwrap(), "remote edit");
        let copies: Vec<_> = std::fs::read_dir(&notes)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains("Konflikt"))
            .collect();
        assert_eq!(copies.len(), 1);
        let copy = std::fs::read_to_string(notes.join(&copies[0])).unwrap();
        assert_eq!(copy, "local edit");
    }

    #[tokio::test]
    async fn deletions_travel_both_ways() {
        let dir = TempDir::new().unwrap();
        let notes = dir.path().join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        std::fs::write(notes.join("gone.md"), "x").unwrap();
        let s = storage(&dir).await;
        sweep(&s, dir.path(), Some(notes.clone()), None, "dev").await.unwrap();

        // Local delete → doc disappears.
        std::fs::remove_file(notes.join("gone.md")).unwrap();
        sweep(&s, dir.path(), Some(notes.clone()), None, "dev").await.unwrap();
        assert!(s.get("files.notes", "gone.md").await.unwrap().is_none());

        // Remote delete → file disappears.
        std::fs::write(notes.join("bye.md"), "y").unwrap();
        sweep(&s, dir.path(), Some(notes.clone()), None, "dev").await.unwrap();
        s.delete("files.notes", "bye.md").await.unwrap();
        sweep(&s, dir.path(), Some(notes.clone()), None, "dev").await.unwrap();
        assert!(!notes.join("bye.md").exists());
    }

    #[tokio::test]
    async fn assistant_docs_use_last_writer_wins_without_copies() {
        let dir = TempDir::new().unwrap();
        let adir = dir.path().join("assistant/profile");
        std::fs::create_dir_all(&adir).unwrap();
        std::fs::write(adir.join("personality.md"), "friendly").unwrap();
        let s = storage(&dir).await;
        sweep(&s, dir.path(), None, Some(dir.path().join("assistant")), "dev").await.unwrap();

        std::fs::write(adir.join("personality.md"), "local tweak").unwrap();
        s.set("files.assistant", "profile/personality.md", doc_value("remote tweak"))
            .await
            .unwrap();
        let report =
            sweep(&s, dir.path(), None, Some(dir.path().join("assistant")), "dev").await.unwrap();
        assert_eq!(report.conflicts, 0);
        assert_eq!(
            std::fs::read_to_string(adir.join("personality.md")).unwrap(),
            "remote tweak"
        );
    }
}
