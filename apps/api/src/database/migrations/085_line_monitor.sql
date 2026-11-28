-- Line monitor and learnings (docs/line-monitor.md). Only new tables and indexes; nothing that
-- exists changes.
-- - egress_pc_events: when each attendant PC stopped or started passing internet. egress_pcs only
--   keeps offline_since, which is cleared when the PC comes back, so an outage left no trace.
-- - line_daily_stats: one row per line per day (in the tenant's timezone) with that day's calls,
--   losses, reconnects and moves, and the line's setup at the end of the day; kept current by
--   LineDailyStatsService and the base of the history and of the learnings.
-- - line_learning_runs: every computation of the learnings, kept to see how they change.
-- - line_notes: what the team changed and when, to read next to the data.
CREATE TABLE IF NOT EXISTS egress_pc_events (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  pc_id TEXT NOT NULL,
  slot TEXT,
  pc_name TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('online', 'offline', 'silent')),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS egress_pc_events_pc_idx ON egress_pc_events (pc_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS egress_pc_events_occurred_idx ON egress_pc_events (occurred_at DESC);

CREATE TABLE IF NOT EXISTS line_daily_stats (
  tenant_id TEXT NOT NULL,
  number_id TEXT NOT NULL,
  day DATE NOT NULL,
  label TEXT NOT NULL,
  waxum_node TEXT,
  status TEXT,
  canary_status TEXT,
  age_days INTEGER,
  young BOOLEAN NOT NULL DEFAULT false,
  stealth BOOLEAN NOT NULL DEFAULT false,
  device_profile BOOLEAN NOT NULL DEFAULT false,
  business BOOLEAN NOT NULL DEFAULT false,
  -- Setup copied from the line's current state for days before this table existed.
  config_estimated BOOLEAN NOT NULL DEFAULT false,
  calls INTEGER NOT NULL DEFAULT 0,
  answered INTEGER NOT NULL DEFAULT 0,
  talk_seconds INTEGER NOT NULL DEFAULT 0,
  short_answered INTEGER NOT NULL DEFAULT 0,
  closed_1005 INTEGER NOT NULL DEFAULT 0,
  waxum_failures INTEGER NOT NULL DEFAULT 0,
  no_whatsapp INTEGER NOT NULL DEFAULT 0,
  losses JSONB NOT NULL DEFAULT '{}'::jsonb,
  lost BOOLEAN NOT NULL DEFAULT false,
  loss_cause TEXT,
  reconnects INTEGER NOT NULL DEFAULT 0,
  node_moves INTEGER NOT NULL DEFAULT 0,
  network_bytes BIGINT NOT NULL DEFAULT 0,
  first_call_at TIMESTAMPTZ,
  last_call_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, number_id, day)
);
CREATE INDEX IF NOT EXISTS line_daily_stats_day_idx ON line_daily_stats (tenant_id, day);

CREATE TABLE IF NOT EXISTS line_learning_runs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id TEXT NOT NULL,
  formula_version INTEGER NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('nightly', 'manual')),
  sample JSONB NOT NULL DEFAULT '{}'::jsonb,
  findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS line_learning_runs_tenant_idx ON line_learning_runs (tenant_id, computed_at DESC);

CREATE TABLE IF NOT EXISTS line_notes (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id TEXT NOT NULL,
  number_id TEXT,
  author_user_id TEXT,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS line_notes_tenant_idx ON line_notes (tenant_id, occurred_at DESC);

-- PC moves of a line are only in the audit log; the daily stats count them per day.
CREATE INDEX IF NOT EXISTS audit_logs_line_moves_idx ON audit_logs (tenant_id, entity_id, created_at) WHERE action = 'number.waxum_node_changed';
