//! cardo-core: Tauri-independent core logic.
//! Storage with mandatory change log, hybrid logical clock, identity and
//! sync abstractions. Everything here is testable with plain `cargo test`.

pub mod diagnose;
pub mod error;
pub mod hlc;
pub mod identity;
pub mod storage;
pub mod sync;

pub use error::{CoreError, Result};
pub use storage::{ChangeNotice, Query, SqliteStorage, StorageAdapter};
