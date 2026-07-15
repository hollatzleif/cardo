-- Sync bookkeeping. The change_log itself has existed since 0001; these
-- tables only track what has crossed the wire.

-- Remote ops that were already applied (idempotency across pulls) plus a
-- fast guard against re-applying our own echoes.
CREATE TABLE IF NOT EXISTS sync_applied (
  op_id      TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- One cursor per transport instance ("where did my last pull end").
CREATE TABLE IF NOT EXISTS sync_cursors (
  transport  TEXT PRIMARY KEY,
  cursor     TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Guard against duplicate op ids in the log (own + applied remote ops live
-- side by side; op_id is globally unique by construction).
CREATE UNIQUE INDEX IF NOT EXISTS idx_change_log_op_id ON change_log (op_id);

-- LWW lookups: latest hlc per (namespace, doc, field).
CREATE INDEX IF NOT EXISTS idx_change_log_doc_field
  ON change_log (namespace, doc_id, field, hlc);
