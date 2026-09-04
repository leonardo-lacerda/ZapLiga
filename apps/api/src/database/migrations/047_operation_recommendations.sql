CREATE TABLE IF NOT EXISTS operation_recommendations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id TEXT,
  code TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'tenant',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'snoozed', 'dismissed', 'resolved', 'expired')),
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('critical', 'warning', 'info')),
  title_key TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  recommended_action JSONB NOT NULL DEFAULT '{}'::jsonb,
  action_type TEXT NOT NULL DEFAULT 'navigate',
  action_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence NUMERIC(5, 4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  impact_scope TEXT NOT NULL DEFAULT 'tenant',
  rule_version INTEGER NOT NULL DEFAULT 1 CHECK (rule_version > 0),
  fingerprint TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  snoozed_until TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code, scope_key),
  CONSTRAINT operation_recommendations_tenant_campaign_fk
    FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recommendation_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recommendation_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('impression', 'opened', 'snoozed', 'dismissed', 'applied', 'failed', 'resolved')),
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  recommendation_status TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT recommendation_events_tenant_recommendation_fk
    FOREIGN KEY (tenant_id, recommendation_id) REFERENCES operation_recommendations (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS operation_recommendations_tenant_status_idx
  ON operation_recommendations (tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS operation_recommendations_tenant_expires_idx
  ON operation_recommendations (tenant_id, expires_at)
  WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS recommendation_events_tenant_created_idx
  ON recommendation_events (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS recommendation_events_recommendation_created_idx
  ON recommendation_events (tenant_id, recommendation_id, created_at DESC);
