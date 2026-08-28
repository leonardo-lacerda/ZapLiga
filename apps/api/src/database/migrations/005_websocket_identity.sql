ALTER TABLE sdrs ADD COLUMN IF NOT EXISTS user_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sdrs_user_fk') THEN
    ALTER TABLE sdrs ADD CONSTRAINT sdrs_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS sdrs_tenant_user_unique
  ON sdrs (tenant_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS websocket_tickets (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS websocket_tickets_active_idx
  ON websocket_tickets (token_hash, expires_at)
  WHERE used_at IS NULL;

ALTER TABLE sdrs VALIDATE CONSTRAINT sdrs_user_fk;
