-- Lote 14: consentimento explícito e agregados privados entre operações.
-- Nenhuma tabela de benchmark guarda tenant_id, lead_id, telefone, nome ou texto
-- livre nos dados agregados que podem ser consultados pelo produto.

CREATE TABLE IF NOT EXISTS benchmark_consent_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('opt_in', 'opt_out')),
  terms_version TEXT NOT NULL,
  purposes TEXT[] NOT NULL CHECK (cardinality(purposes) > 0),
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS benchmark_consent_events_current_idx
  ON benchmark_consent_events (tenant_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS benchmark_cohort_runs (
  id TEXT PRIMARY KEY,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  minimum_tenants INTEGER NOT NULL CHECK (minimum_tenants > 1),
  minimum_calls_per_tenant INTEGER NOT NULL CHECK (minimum_calls_per_tenant > 0),
  status TEXT NOT NULL CHECK (status IN ('completed', 'insufficient_data', 'failed')),
  cohort_count INTEGER NOT NULL DEFAULT 0 CHECK (cohort_count >= 0),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_end > period_start)
);

CREATE TABLE IF NOT EXISTS benchmark_cohort_aggregates (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES benchmark_cohort_runs(id) ON DELETE CASCADE,
  cohort_key TEXT NOT NULL,
  team_size_band TEXT NOT NULL,
  volume_band TEXT NOT NULL,
  tenant_count INTEGER NOT NULL CHECK (tenant_count > 1),
  call_count INTEGER NOT NULL CHECK (call_count >= 0),
  answer_rate_p25 NUMERIC(8, 5),
  answer_rate_median NUMERIC(8, 5),
  answer_rate_p75 NUMERIC(8, 5),
  answer_rate_trimmed NUMERIC(8, 5),
  positive_rate_trimmed NUMERIC(8, 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, cohort_key)
);

CREATE INDEX IF NOT EXISTS benchmark_cohort_runs_recent_idx
  ON benchmark_cohort_runs (computed_at DESC);
CREATE INDEX IF NOT EXISTS benchmark_cohort_aggregates_run_idx
  ON benchmark_cohort_aggregates (run_id, team_size_band, volume_band);
