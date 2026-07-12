-- Cardo polls: one row per (poll, installation). Nothing else is stored –
-- no IP, no user agent, no timestamps beyond the vote date. Privacy is the product.
CREATE TABLE IF NOT EXISTS votes (
  poll_id TEXT NOT NULL,
  device_hash TEXT NOT NULL,
  option_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (poll_id, device_hash)
);
