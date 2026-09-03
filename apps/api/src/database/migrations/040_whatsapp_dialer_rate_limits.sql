-- Per-line rolling call window. The defaults are deliberately conservative:
-- three attempts in 180 seconds, in addition to one active call and the
-- existing per-line cooldown. Values are operator-tunable through the number
-- settings endpoint and are enforced atomically in Redis.
ALTER TABLE whatsapp_numbers
  ADD COLUMN IF NOT EXISTS max_calls_per_window INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS call_window_seconds INTEGER NOT NULL DEFAULT 180;

UPDATE whatsapp_numbers
SET max_calls_per_window = 3
WHERE max_calls_per_window IS NULL OR max_calls_per_window < 1;

UPDATE whatsapp_numbers
SET call_window_seconds = 180
WHERE call_window_seconds IS NULL OR call_window_seconds < 60;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_numbers_rate_window_limits'
  ) THEN
    ALTER TABLE whatsapp_numbers
      ADD CONSTRAINT whatsapp_numbers_rate_window_limits
      CHECK (max_calls_per_window BETWEEN 1 AND 20 AND call_window_seconds BETWEEN 60 AND 3600);
  END IF;
END $$;
