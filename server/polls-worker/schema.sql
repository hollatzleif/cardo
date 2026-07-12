-- Cardo polls: one row per (poll, installation). Nothing else is stored –
-- no IP, no user agent, no timestamps beyond the vote date. Privacy is the product.
CREATE TABLE IF NOT EXISTS votes (
  poll_id TEXT NOT NULL,
  device_hash TEXT NOT NULL,
  option_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (poll_id, device_hash)
);

-- Feed items: polls and announcements, managed via the admin API.
-- payload is JSON:
--   poll         -> { "question": {"en","de"}, "options": [{"id","label":{"en","de"}}] }
--   announcement -> { "title": {"en","de"}, "body": {"en","de"} }
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,            -- kebab slug, server-generated from title + random suffix
  kind TEXT NOT NULL CHECK (kind IN ('poll','announcement')),
  payload TEXT NOT NULL,
  open INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- Admin login rate limiting: one global counter per fixed 10-minute window.
-- Deliberately NOT keyed by IP – the worker never sees or stores client identity.
CREATE TABLE IF NOT EXISTS login_attempts (
  window_start TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);
