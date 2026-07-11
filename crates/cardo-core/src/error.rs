use thiserror::Error;

pub type Result<T> = std::result::Result<T, CoreError>;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("invalid namespace: {0}")]
    InvalidNamespace(String),
    #[error("invalid query field: {0}")]
    InvalidField(String),
    #[error("invalid document id: {0}")]
    InvalidId(String),
    #[error("document value must be a JSON object")]
    NotAnObject,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Other(String),
}
