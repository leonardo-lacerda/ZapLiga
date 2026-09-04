-- Versioned, tenant-scoped operational health read model.
-- Snapshots are immutable observations; number events provide a normalized
-- timeline over the existing status history and protection signals.

CREATE TABLE IF NOT EXISTS operation_health_snapshots (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('healthy', 'attention', 'degraded', 'blocked', 'insufficient_data')),
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  component_scores JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  sample_size INTEGER NOT NULL DEFAULT 0 CHECK (sample_size >= 0),
  formula_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS operation_health_snapshots_tenant_created_idx
  ON operation_health_snapshots (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS number_health_events (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number_id TEXT NOT NULL REFERENCES whatsapp_numbers(id) ON DELETE CASCADE,
  source_event_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'connected', 'disconnected', 'reconnected', 'cooldown_started',
    'cooldown_finished', 'quarantine_started', 'quarantine_finished',
    'rate_limited', 'rapid_failure', 'media_active', 'manual_protection'
  )),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('automatic', 'human')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS number_health_events_source_unique
  ON number_health_events (tenant_id, source_event_id)
  WHERE source_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS number_health_events_tenant_number_occurred_idx
  ON number_health_events (tenant_id, number_id, occurred_at DESC);

-- The legacy history table is already tenant-scoped and is the source of
-- truth for connection transitions. The normalized event table intentionally
-- remains additive so old installations can migrate without losing history.
