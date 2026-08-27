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
  failure_reason TEXT
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
CREATE INDEX IF NOT EXISTS leads_queue_idx ON leads(status, next_eligible_at) WHERE do_not_call = false;
CREATE INDEX IF NOT EXISTS calls_created_idx ON calls(created_at DESC);
