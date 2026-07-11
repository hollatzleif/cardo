use async_trait::async_trait;

use crate::error::Result;

/// Sync transport abstraction. The MVP ships ONLY this interface plus the
/// no-op implementation – but the change log records every operation from
/// day one, so the real `KeySyncTransport` (release 1.1/1.2) plugs in
/// without touching storage or tools.
#[async_trait]
pub trait SyncTransport: Send + Sync {
    async fn push(&self, ops: Vec<EncryptedOp>) -> Result<PushAck>;
    async fn pull(&self, since: Cursor) -> Result<PullBatch>;
}

/// An end-to-end encrypted change-log operation. The server only ever sees
/// opaque blobs (zero-knowledge relay).
#[derive(Debug, Clone)]
pub struct EncryptedOp {
    pub op_id: String,
    pub blob: Vec<u8>,
}

pub type Cursor = String;

#[derive(Debug, Clone)]
pub struct PushAck {
    pub accepted: usize,
}

#[derive(Debug, Clone, Default)]
pub struct PullBatch {
    pub ops: Vec<EncryptedOp>,
    pub next_cursor: Cursor,
}

/// MVP: sync is off, nothing moves.
pub struct NoopSyncTransport;

#[async_trait]
impl SyncTransport for NoopSyncTransport {
    async fn push(&self, _ops: Vec<EncryptedOp>) -> Result<PushAck> {
        Ok(PushAck { accepted: 0 })
    }

    async fn pull(&self, _since: Cursor) -> Result<PullBatch> {
        Ok(PullBatch::default())
    }
}
