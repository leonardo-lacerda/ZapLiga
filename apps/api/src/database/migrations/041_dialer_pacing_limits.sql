-- Explicit operation-level pacing controls. They complement the per-line
-- rolling window from migration 040 and are enforced atomically in Redis.
ALTER TABLE dialer_settings
  ADD COLUMN IF NOT EXISTS max_calls_per_minute INTEGER NOT NULL DEFAULT 6,
  ADD COLUMN IF NOT EXISTS min_seconds_between_calls INTEGER NOT NULL DEFAULT 10;

UPDATE dialer_settings
SET max_calls_per_minute = 6
WHERE max_calls_per_minute IS NULL OR max_calls_per_minute < 1;

UPDATE dialer_settings
SET min_seconds_between_calls = 10
WHERE min_seconds_between_calls IS NULL OR min_seconds_between_calls < 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dialer_settings_pacing_limits'
  ) THEN
    ALTER TABLE dialer_settings
      ADD CONSTRAINT dialer_settings_pacing_limits
      CHECK (max_calls_per_minute BETWEEN 1 AND 60 AND min_seconds_between_calls BETWEEN 0 AND 3600);
  END IF;
END $$;
