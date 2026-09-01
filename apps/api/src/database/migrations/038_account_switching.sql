CREATE TABLE IF NOT EXISTS browser_account_links (
  id TEXT PRIMARY KEY,
  browser_id_hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  UNIQUE (browser_id_hash, user_id)
);

CREATE INDEX IF NOT EXISTS browser_account_links_browser_idx ON browser_account_links (browser_id_hash, last_used_at DESC);
