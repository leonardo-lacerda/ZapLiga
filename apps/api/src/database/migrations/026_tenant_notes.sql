-- Internal admin notes attached to a tenant (support history, context for the
-- next person who picks up the account). Not visible to the tenant itself.
CREATE TABLE IF NOT EXISTS tenant_notes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  pinned BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_notes_tenant_idx ON tenant_notes (tenant_id, created_at DESC);
