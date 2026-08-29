ALTER TABLE user_sessions
  ADD COLUMN IF NOT EXISTS rotation_grace_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS user_sessions_rotation_grace_idx
  ON user_sessions (rotation_grace_until)
  WHERE rotation_grace_until IS NOT NULL;
