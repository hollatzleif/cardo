-- Additive tables: created IF NOT EXISTS on every open, WITHOUT bumping
-- user_version, so older builds (which ignore unknown tables) can still open
-- the database after a downgrade. Only ever ADD tables/indexes here.

-- Authentic remote ops (they decrypted) that this build could not parse or
-- apply: an unknown op kind from a newer client, an id/field a newer
-- validator accepts, malformed JSON. A build with a different `stamp`
-- retries them (see sync_engine.rs PARK_STAMP) instead of losing them.
CREATE TABLE IF NOT EXISTS sync_parked (
  op_id     TEXT PRIMARY KEY,
  payload   BLOB    NOT NULL,
  reason    TEXT    NOT NULL,
  stamp     TEXT    NOT NULL,
  parked_at INTEGER NOT NULL
);
