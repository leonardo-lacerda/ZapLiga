CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL,
  name TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  primary_metric TEXT NOT NULL CHECK (primary_metric IN ('answer_rate', 'positive_rate', 'failure_rate', 'rapid_drop_rate')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'paused', 'stopped', 'completed', 'archived')),
  traffic_percent INTEGER NOT NULL DEFAULT 100 CHECK (traffic_percent BETWEEN 1 AND 100),
  assignment_salt TEXT NOT NULL,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  stopped_at TIMESTAMPTZ,
  stop_reason TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, campaign_id, name),
  CONSTRAINT experiments_tenant_campaign_fk
    FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS experiment_variants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  experiment_id TEXT NOT NULL,
  variant_key TEXT NOT NULL,
  name TEXT NOT NULL,
  allocation_percent INTEGER NOT NULL CHECK (allocation_percent BETWEEN 1 AND 100),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, experiment_id, variant_key),
  UNIQUE (tenant_id, experiment_id, id),
  CONSTRAINT experiment_variants_experiment_fk
    FOREIGN KEY (tenant_id, experiment_id) REFERENCES experiments (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS experiment_guardrails (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  experiment_id TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('failure_rate', 'opt_out_rate', 'rapid_drop_rate', 'line_failure_rate')),
  operator TEXT NOT NULL DEFAULT 'max' CHECK (operator IN ('max', 'min')),
  threshold NUMERIC(8, 5) NOT NULL CHECK (threshold >= 0 AND threshold <= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, experiment_id, metric),
  CONSTRAINT experiment_guardrails_experiment_fk
    FOREIGN KEY (tenant_id, experiment_id) REFERENCES experiments (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS experiment_assignments (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  experiment_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  assignment_hash TEXT NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, experiment_id, lead_id),
  CONSTRAINT experiment_assignments_experiment_fk
    FOREIGN KEY (tenant_id, experiment_id) REFERENCES experiments (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT experiment_assignments_lead_fk
    FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT experiment_assignments_variant_fk
    FOREIGN KEY (tenant_id, experiment_id, variant_id)
    REFERENCES experiment_variants (tenant_id, experiment_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS experiment_guardrail_evaluations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  experiment_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  observed_value NUMERIC(8, 5) NOT NULL,
  threshold NUMERIC(8, 5) NOT NULL,
  sample_size INTEGER NOT NULL DEFAULT 0 CHECK (sample_size >= 0),
  action TEXT NOT NULL CHECK (action IN ('observed', 'insufficient_data', 'stopped')),
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT experiment_guardrail_evaluations_experiment_fk
    FOREIGN KEY (tenant_id, experiment_id) REFERENCES experiments (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS experiments_tenant_status_idx
  ON experiments (tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS experiment_variants_tenant_experiment_idx
  ON experiment_variants (tenant_id, experiment_id);
CREATE INDEX IF NOT EXISTS experiment_assignments_tenant_experiment_variant_idx
  ON experiment_assignments (tenant_id, experiment_id, variant_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS experiment_assignments_tenant_lead_idx
  ON experiment_assignments (tenant_id, lead_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS experiment_guardrail_evaluations_tenant_experiment_idx
  ON experiment_guardrail_evaluations (tenant_id, experiment_id, evaluated_at DESC);

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS experiment_id TEXT,
  ADD COLUMN IF NOT EXISTS experiment_variant_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calls_experiment_fk') THEN
    ALTER TABLE calls
      ADD CONSTRAINT calls_experiment_fk
      FOREIGN KEY (tenant_id, experiment_id) REFERENCES experiments (tenant_id, id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calls_experiment_variant_fk') THEN
    ALTER TABLE calls
      ADD CONSTRAINT calls_experiment_variant_fk
      FOREIGN KEY (tenant_id, experiment_id, experiment_variant_id)
      REFERENCES experiment_variants (tenant_id, experiment_id, id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS calls_tenant_experiment_created_idx
  ON calls (tenant_id, experiment_id, created_at DESC)
  WHERE experiment_id IS NOT NULL;
