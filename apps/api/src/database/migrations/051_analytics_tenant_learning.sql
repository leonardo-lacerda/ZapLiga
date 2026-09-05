-- Lote 12: sinais históricos explicáveis por tenant. Nenhum identificador de
-- pessoa, telefone, nome ou texto livre é materializado nestes agregados.

CREATE TABLE IF NOT EXISTS analytics_tenant_signal_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  granularity TEXT NOT NULL CHECK (granularity IN ('period')),
  dimension TEXT NOT NULL CHECK (dimension IN ('tenant', 'day_hour', 'campaign', 'source', 'recency', 'attempt', 'stage', 'line')),
  dimension_value TEXT NOT NULL,
  sample_size INTEGER NOT NULL CHECK (sample_size >= 0),
  raw_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  smoothed_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence TEXT NOT NULL CHECK (confidence IN ('insufficient_data', 'directional', 'reliable')),
  reliability_score NUMERIC(5,2),
  reliability_status TEXT NOT NULL CHECK (reliability_status IN ('reliable', 'attention', 'unreliable', 'insufficient_data')),
  formula_version INTEGER NOT NULL DEFAULT 1,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_start, period_end, granularity, dimension, dimension_value)
);

CREATE INDEX IF NOT EXISTS analytics_tenant_signals_lookup_idx
  ON analytics_tenant_signal_snapshots (tenant_id, dimension, computed_at DESC);

CREATE TABLE IF NOT EXISTS analytics_tenant_learning_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  minimum_sample_size INTEGER NOT NULL CHECK (minimum_sample_size > 0),
  snapshot_count INTEGER NOT NULL DEFAULT 0 CHECK (snapshot_count >= 0),
  reliability_score NUMERIC(5,2),
  reliability_status TEXT NOT NULL CHECK (reliability_status IN ('reliable', 'attention', 'unreliable', 'insufficient_data')),
  status TEXT NOT NULL CHECK (status IN ('completed', 'insufficient_data', 'failed')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_end > period_start)
);

CREATE INDEX IF NOT EXISTS analytics_tenant_learning_runs_lookup_idx
  ON analytics_tenant_learning_runs (tenant_id, computed_at DESC);
