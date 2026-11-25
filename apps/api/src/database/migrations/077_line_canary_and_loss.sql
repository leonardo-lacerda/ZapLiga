-- WhatsApp removes a newly paired device on the offer of its first call. So:
-- - loss_reason/loss_at/removal_count: why the line was lost (device removed or account
--   locked, from the Waxum events) and how many times. A line lost twice is retired.
-- - last_paired_at: when its last pairing QR or code was shown. Young lines (paired in the
--   last days) have a daily call cap.
-- - canary_status: after each pairing the first call of a line goes to a team phone
--   (dialer_settings.canary_phones), never to a lead; the line only dials leads once that
--   call passes. Lines that already exist stay `passed`.
ALTER TABLE whatsapp_numbers
  ADD COLUMN IF NOT EXISTS loss_reason TEXT CHECK (loss_reason IN ('device_removed', 'account_locked')),
  ADD COLUMN IF NOT EXISTS loss_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS removal_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_paired_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS canary_status TEXT NOT NULL DEFAULT 'passed' CHECK (canary_status IN ('pending', 'passed', 'failed'));

ALTER TABLE dialer_settings ADD COLUMN IF NOT EXISTS canary_phones TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE calls ADD COLUMN IF NOT EXISTS canary BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE number_health_events DROP CONSTRAINT IF EXISTS number_health_events_event_type_check;
ALTER TABLE number_health_events ADD CONSTRAINT number_health_events_event_type_check CHECK (event_type IN (
  'connected', 'disconnected', 'reconnected', 'cooldown_started',
  'cooldown_finished', 'quarantine_started', 'quarantine_finished',
  'rate_limited', 'rapid_failure', 'media_active', 'manual_protection',
  'device_removed', 'account_locked', 'canary_passed', 'canary_failed'
));
