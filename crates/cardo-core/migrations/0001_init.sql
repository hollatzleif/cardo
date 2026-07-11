-- Cardo schema v1: document store + change log (sync/team foundation from day one)

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  namespace  TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  data       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (namespace, id)
);

CREATE INDEX IF NOT EXISTS idx_docs_ns_updated ON documents(namespace, updated_at);

CREATE TABLE IF NOT EXISTS change_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id      TEXT    NOT NULL UNIQUE,
  device_id  TEXT    NOT NULL,
  hlc        TEXT    NOT NULL,
  namespace  TEXT    NOT NULL,
  doc_id     TEXT    NOT NULL,
  op         TEXT    NOT NULL CHECK (op IN ('create','set_field','delete_field','delete_doc')),
  field      TEXT,
  value      TEXT,
  created_at INTEGER NOT NULL,
  synced     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_changelog_unsynced ON change_log(synced, seq);
