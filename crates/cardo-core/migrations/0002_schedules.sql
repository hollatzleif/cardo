-- Cardo schema v2: persistent scheduler.
-- Alarms and reminders survive restarts; overdue entries fire on next launch.

CREATE TABLE IF NOT EXISTS schedules (
  id         TEXT    PRIMARY KEY,
  fire_at    INTEGER NOT NULL, -- unix ms
  command_id TEXT    NOT NULL,
  params     TEXT    NOT NULL, -- JSON
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_schedules_fire_at ON schedules(fire_at);
