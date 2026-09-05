-- Lote 11: contrato analítico versionado, outbox transacional, qualidade e
-- entregas outbound idempotentes. Payloads analíticos são sanitizados no código
-- antes da escrita; estas tabelas não devem receber nome, telefone, notas ou
-- texto livre do domínio operacional.

CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  campaign_id TEXT,
  campaign_version INTEGER,
  correlation_id TEXT,
  idempotency_key TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT analytics_events_tenant_campaign_fk
    FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns (tenant_id, id),
  CONSTRAINT analytics_events_tenant_version_fk
    FOREIGN KEY (tenant_id, campaign_id, campaign_version)
    REFERENCES campaign_versions (tenant_id, campaign_id, version),
  CONSTRAINT analytics_events_campaign_version_check
    CHECK (campaign_version IS NULL OR campaign_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS analytics_events_tenant_type_occurred_idx
  ON analytics_events (tenant_id, event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS analytics_events_tenant_aggregate_idx
  ON analytics_events (tenant_id, aggregate_type, aggregate_id, occurred_at);

CREATE TABLE IF NOT EXISTS analytics_event_outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT analytics_event_outbox_tenant_event_fk
    FOREIGN KEY (tenant_id, event_id) REFERENCES analytics_events (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS analytics_event_outbox_pending_idx
  ON analytics_event_outbox (status, next_attempt_at, created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS analytics_event_outbox_tenant_created_idx
  ON analytics_event_outbox (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS analytics_event_receipts (
  event_id TEXT PRIMARY KEY REFERENCES analytics_events(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS analytics_event_receipts_tenant_processed_idx
  ON analytics_event_receipts (tenant_id, processed_at DESC);

CREATE TABLE IF NOT EXISTS analytics_reconciliation_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  source_calls INTEGER NOT NULL DEFAULT 0,
  event_calls INTEGER NOT NULL DEFAULT 0,
  missing_events INTEGER NOT NULL DEFAULT 0,
  duplicate_events INTEGER NOT NULL DEFAULT 0,
  invalid_events INTEGER NOT NULL DEFAULT 0,
  future_events INTEGER NOT NULL DEFAULT 0,
  out_of_order_events INTEGER NOT NULL DEFAULT 0,
  rollup_divergences INTEGER NOT NULL DEFAULT 0,
  pending_outbox INTEGER NOT NULL DEFAULT 0,
  reliability_score NUMERIC(5,2) NOT NULL CHECK (reliability_score BETWEEN 0 AND 100),
  reliability_status TEXT NOT NULL CHECK (reliability_status IN ('reliable', 'attention', 'unreliable', 'insufficient_data')),
  formula_version INTEGER NOT NULL DEFAULT 1,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_end > period_start)
);

CREATE INDEX IF NOT EXISTS analytics_reconciliation_tenant_computed_idx
  ON analytics_reconciliation_runs (tenant_id, computed_at DESC);

CREATE TABLE IF NOT EXISTS outbound_webhook_endpoints (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  event_types JSONB NOT NULL DEFAULT '["*"]'::jsonb,
  secret_ciphertext TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS outbound_webhook_endpoints_tenant_status_idx
  ON outbound_webhook_endpoints (tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS outbound_webhook_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  endpoint_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed', 'dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  last_status_code INTEGER,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, endpoint_id, event_id),
  UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT outbound_webhook_deliveries_tenant_endpoint_fk
    FOREIGN KEY (tenant_id, endpoint_id) REFERENCES outbound_webhook_endpoints (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT outbound_webhook_deliveries_tenant_event_fk
    FOREIGN KEY (tenant_id, event_id) REFERENCES analytics_events (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS outbound_webhook_deliveries_pending_idx
  ON outbound_webhook_deliveries (status, next_attempt_at, created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS outbound_webhook_deliveries_tenant_created_idx
  ON outbound_webhook_deliveries (tenant_id, created_at DESC);
