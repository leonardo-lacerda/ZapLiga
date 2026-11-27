-- Why each line was lost, instead of "a linha caiu" (docs/line-loss-causes.md):
-- - line_loss_events: one row per WhatsApp signal about a line's health (lock, removed device,
--   temporary ban, reachout timelock, refused connection...), append-only, to count by cause.
-- - whatsapp_numbers.loss_cause / loss_detail: the last cause that took the line out, with what
--   the server said (violation_reason, vt...); loss_reason stays for the two causes it always had.
-- - whatsapp_numbers.dial_blocked_until / dial_block_cause: the line must not dial until then, for
--   a cause the server stated (temporary ban, reachout timelock) or a short media quarantine. Kept
--   apart from flagged_until, which also carries the pairing block and the canary rest.
-- - whatsapp_numbers.registration_reason: what the phone showed when WhatsApp refused it (the
--   registration flow never reaches a companion device, so an operator records it by hand).
CREATE TABLE IF NOT EXISTS line_loss_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  number_id TEXT NOT NULL,
  waxum_session_id TEXT,
  cause TEXT NOT NULL CHECK (cause IN (
    'device_removed', 'account_locked', 'temp_banned', 'reachout_timelock', 'logged_out_other',
    'client_rejected', 'transient', 'media_failure', 'unknown', 'registration'
  )),
  source_event TEXT NOT NULL,
  code TEXT,
  violation_type TEXT,
  violation_reason TEXT,
  expires_at TIMESTAMPTZ,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS line_loss_events_number_idx ON line_loss_events (tenant_id, number_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS line_loss_events_cause_idx ON line_loss_events (tenant_id, cause, occurred_at DESC);

ALTER TABLE whatsapp_numbers
  ADD COLUMN IF NOT EXISTS loss_cause TEXT,
  ADD COLUMN IF NOT EXISTS loss_detail JSONB,
  ADD COLUMN IF NOT EXISTS dial_blocked_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dial_block_cause TEXT,
  ADD COLUMN IF NOT EXISTS registration_reason TEXT CHECK (registration_reason IN (
    'blocked', 'temporarily_unavailable', 'limited_release', 'not_allowed', 'reset_too_soon',
    'too_many_guesses', 'guessed_too_fast', 'stale'
  ));

ALTER TABLE number_health_events DROP CONSTRAINT IF EXISTS number_health_events_event_type_check;
ALTER TABLE number_health_events ADD CONSTRAINT number_health_events_event_type_check CHECK (event_type IN (
  'connected', 'disconnected', 'reconnected', 'cooldown_started',
  'cooldown_finished', 'quarantine_started', 'quarantine_finished',
  'rate_limited', 'rapid_failure', 'media_active', 'manual_protection',
  'device_removed', 'account_locked', 'canary_passed', 'canary_failed',
  'temp_banned', 'reachout_timelock', 'logged_out_other', 'media_failure', 'registration_reason'
));

-- History already in the database, so the counts start with a baseline: the losses recorded so
-- far and every 463 (reachout timelock) the server answered to an offer. Inserts only.
INSERT INTO line_loss_events (id, tenant_id, number_id, cause, source_event, detail, occurred_at)
SELECT 'backfill:health:' || h.id, h.tenant_id, h.number_id, h.event_type, h.event_type, COALESCE(h.metadata, '{}'::jsonb), h.occurred_at
FROM number_health_events h
WHERE h.event_type IN ('device_removed', 'account_locked')
ON CONFLICT (id) DO NOTHING;

INSERT INTO line_loss_events (id, tenant_id, number_id, cause, source_event, code, detail, occurred_at)
SELECT 'backfill:signal:' || s.id, s.tenant_id, s.number_id, 'reachout_timelock', 'call_ack', '463', s.detail, s.received_at
FROM call_signal_events s
WHERE s.kind = 'call_ack' AND s.detail->>'error' = '463'
ON CONFLICT (id) DO NOTHING;

UPDATE whatsapp_numbers SET loss_cause = loss_reason WHERE loss_reason IS NOT NULL AND loss_cause IS NULL;
