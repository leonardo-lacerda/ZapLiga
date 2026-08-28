-- Baseline for the operational schema that was previously created by schema.sql.
-- This migration is intentionally idempotent for databases initialized before
-- the versioned migration runner existed.

CREATE TABLE IF NOT EXISTS whatsapp_numbers (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  phone TEXT,
  waxum_session_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'disconnected',
  max_concurrent_calls INTEGER NOT NULL DEFAULT 1,
  cooldown_seconds INTEGER NOT NULL DEFAULT 60,
  last_call_ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_eligible_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  do_not_call BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sdrs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  session_id TEXT,
  available BOOLEAN NOT NULL DEFAULT false,
  state TEXT NOT NULL DEFAULT 'offline',
  current_pause_id TEXT,
  last_assigned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  number_id TEXT NOT NULL REFERENCES whatsapp_numbers(id),
  sdr_id TEXT NOT NULL REFERENCES sdrs(id),
  status TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  connected_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  offer_expires_at TIMESTAMPTZ,
  outcome TEXT,
  failure_reason TEXT,
  call_result TEXT,
  pipeline_stage TEXT,
  notes TEXT,
  wrap_up_completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sdr_pauses (
  id TEXT PRIMARY KEY,
  sdr_id TEXT NOT NULL REFERENCES sdrs(id),
  call_id TEXT REFERENCES calls(id),
  pause_type TEXT NOT NULL DEFAULT 'post_call',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dialer_settings (
  id BOOLEAN PRIMARY KEY DEFAULT true,
  running BOOLEAN NOT NULL DEFAULT false,
  global_max_concurrent_calls INTEGER NOT NULL DEFAULT 1,
  max_attempts_per_lead INTEGER NOT NULL DEFAULT 2,
  retry_delay_minutes INTEGER NOT NULL DEFAULT 30,
  ring_timeout_seconds INTEGER NOT NULL DEFAULT 30,
  default_number_cooldown_seconds INTEGER NOT NULL DEFAULT 60,
  number_rotation_cursor INTEGER NOT NULL DEFAULT 0,
  sdr_rotation_cursor INTEGER NOT NULL DEFAULT 0
);

INSERT INTO dialer_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS pipeline_stage TEXT NOT NULL DEFAULT 'novo';
ALTER TABLE sdrs ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'offline';
ALTER TABLE sdrs ADD COLUMN IF NOT EXISTS current_pause_id TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS call_result TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS pipeline_stage TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS wrap_up_completed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS leads_queue_idx ON leads(status, next_eligible_at) WHERE do_not_call = false;
CREATE INDEX IF NOT EXISTS calls_created_idx ON calls(created_at DESC);
CREATE INDEX IF NOT EXISTS sdr_pauses_open_idx ON sdr_pauses(sdr_id, started_at DESC) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS calls_wrap_up_idx ON calls(wrap_up_completed_at) WHERE connected_at IS NOT NULL;
