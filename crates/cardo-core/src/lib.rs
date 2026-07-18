//! cardo-core: Tauri-independent core logic.
//! Storage with mandatory change log, hybrid logical clock, identity and
//! sync abstractions. Everything here is testable with plain `cargo test`.

pub mod anki;
pub mod diagnose;
pub mod error;
pub mod hlc;
pub mod identity;
pub mod storage;
pub mod sync;
pub mod sync_crypto;
pub mod srs;
pub mod sync_engine;
pub mod sync_folder;
pub mod sync_keys;

pub use error::{CoreError, Result};
pub use srs::{CardState, FsrsConfig, Interval, Phase, Rating, Scheduler, Sm2Config};
pub use storage::{ChangeNotice, Query, SqliteStorage, StorageAdapter, SyncOp};
pub use sync_engine::{SyncEngine, SyncReport};
pub use sync_folder::FolderTransport;
pub use sync_keys::{DerivedKeys, SyncKey};
