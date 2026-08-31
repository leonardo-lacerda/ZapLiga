ALTER TABLE invitations ADD COLUMN IF NOT EXISTS delivery_token_encrypted TEXT;
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS next_delivery_attempt_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS invitations_delivery_queue_idx ON invitations (next_delivery_attempt_at)
  WHERE delivery_status = 'queued' AND accepted_at IS NULL AND revoked_at IS NULL;
