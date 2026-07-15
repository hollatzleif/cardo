use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{CoreError, Result};
use crate::sync::{Cursor, EncryptedOp, PullBatch, PushAck, SyncTransport};

/// File-based transport: encrypted op batches as JSON files in one shared
/// folder. Whatever syncs that folder between machines (iCloud Drive,
/// Dropbox, Syncthing, a network share) becomes the carrier – the files
/// themselves stay opaque. Also the reference implementation the WebDAV and
/// Google Drive transports mirror (same batch-file shape, same
/// lexicographic-filename cursor).
///
/// Layout: `<root>/ops/<created_ms:013>-<uuid>.cardo-ops` – zero-padded
/// millis make names sort chronologically; the uuid departs ties between
/// devices. The cursor is simply the last filename processed.
pub struct FolderTransport {
    ops_dir: PathBuf,
}

#[derive(Serialize, Deserialize)]
struct BatchFile {
    version: u32,
    ops: Vec<WireOp>,
}

#[derive(Serialize, Deserialize)]
struct WireOp {
    op_id: String,
    /// Base64 (std alphabet) of the encrypted blob – keeps the file JSON.
    blob_b64: String,
}

const BATCH_EXT: &str = "cardo-ops";

impl FolderTransport {
    pub fn new(root: impl AsRef<Path>) -> Result<Self> {
        let ops_dir = root.as_ref().join("ops");
        std::fs::create_dir_all(&ops_dir)?;
        Ok(Self { ops_dir })
    }

    fn now_ms() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    }
}

#[async_trait]
impl SyncTransport for FolderTransport {
    async fn push(&self, ops: Vec<EncryptedOp>) -> Result<PushAck> {
        if ops.is_empty() {
            return Ok(PushAck { accepted: 0 });
        }
        let batch = BatchFile {
            version: 1,
            ops: ops
                .iter()
                .map(|op| WireOp { op_id: op.op_id.clone(), blob_b64: b64_encode(&op.blob) })
                .collect(),
        };
        let name = format!("{:013}-{}.{}", Self::now_ms(), Uuid::new_v4(), BATCH_EXT);
        let final_path = self.ops_dir.join(&name);
        // Write-then-rename: folder syncers never see half a file.
        let tmp_path = self.ops_dir.join(format!(".{name}.tmp"));
        std::fs::write(&tmp_path, serde_json::to_vec(&batch)?)?;
        std::fs::rename(&tmp_path, &final_path)?;
        Ok(PushAck { accepted: ops.len() })
    }

    async fn pull(&self, since: Cursor) -> Result<PullBatch> {
        let mut names: Vec<String> = std::fs::read_dir(&self.ops_dir)?
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.ends_with(BATCH_EXT) && !name.starts_with('.'))
            .filter(|name| name.as_str() > since.as_str())
            .collect();
        names.sort();

        let mut ops = Vec::new();
        let mut cursor = since;
        // Bounded batch per pull call; the engine loops until drained.
        for name in names.into_iter().take(50) {
            let raw = std::fs::read(self.ops_dir.join(&name))?;
            let batch: BatchFile = serde_json::from_slice(&raw)
                .map_err(|e| CoreError::Other(format!("broken batch file {name}: {e}")))?;
            for op in batch.ops {
                let blob = b64_decode(&op.blob_b64)
                    .ok_or_else(|| CoreError::Other(format!("broken blob in {name}")))?;
                ops.push(EncryptedOp { op_id: op.op_id, blob });
            }
            cursor = name;
        }
        Ok(PullBatch { ops, next_cursor: cursor })
    }
}

/* ── std-only base64 (RFC 4648) ───────────────────────────────────────── */

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

fn b64_decode(text: &str) -> Option<Vec<u8>> {
    let cleaned: Vec<u8> = text.bytes().filter(|&b| b != b'=').collect();
    let mut out = Vec::with_capacity(cleaned.len() * 3 / 4);
    for chunk in cleaned.chunks(4) {
        let mut n: u32 = 0;
        for &c in chunk {
            let v = B64.iter().position(|&a| a == c)? as u32;
            n = (n << 6) | v;
        }
        match chunk.len() {
            4 => {
                out.push((n >> 16) as u8);
                out.push((n >> 8) as u8);
                out.push(n as u8);
            }
            3 => {
                n <<= 6;
                out.push((n >> 16) as u8);
                out.push((n >> 8) as u8);
            }
            2 => {
                n <<= 12;
                out.push((n >> 16) as u8);
            }
            _ => return None,
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn base64_roundtrip() {
        for len in 0..40 {
            let data: Vec<u8> = (0..len as u8).map(|b| b.wrapping_mul(37)).collect();
            assert_eq!(b64_decode(&b64_encode(&data)).unwrap(), data);
        }
    }

    #[tokio::test]
    async fn push_pull_roundtrip_with_cursor() {
        let dir = TempDir::new().unwrap();
        let t = FolderTransport::new(dir.path()).unwrap();

        t.push(vec![EncryptedOp { op_id: "op-1".into(), blob: vec![1, 2, 3] }])
            .await
            .unwrap();
        t.push(vec![EncryptedOp { op_id: "op-2".into(), blob: vec![4, 5] }])
            .await
            .unwrap();

        let first = t.pull(String::new()).await.unwrap();
        assert_eq!(first.ops.len(), 2);
        assert_eq!(first.ops[0].op_id, "op-1");
        assert_eq!(first.ops[1].blob, vec![4, 5]);

        // Cursor: nothing new afterwards.
        let second = t.pull(first.next_cursor.clone()).await.unwrap();
        assert!(second.ops.is_empty());
        assert_eq!(second.next_cursor, first.next_cursor);
    }

    #[tokio::test]
    async fn empty_push_writes_nothing() {
        let dir = TempDir::new().unwrap();
        let t = FolderTransport::new(dir.path()).unwrap();
        t.push(vec![]).await.unwrap();
        assert!(t.pull(String::new()).await.unwrap().ops.is_empty());
    }
}
