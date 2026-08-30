ALTER TABLE sdrs ADD COLUMN IF NOT EXISTS connection_instance_id TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS owner_instance_id TEXT;

CREATE INDEX IF NOT EXISTS idx_sdrs_connection_instance
  ON sdrs (connection_instance_id) WHERE connection_instance_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_calls_owner_status
  ON calls (owner_instance_id, status) WHERE owner_instance_id IS NOT NULL;
