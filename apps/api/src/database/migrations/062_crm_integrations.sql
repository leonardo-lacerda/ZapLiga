-- CRM integrations (first consumer: Franco). A tenant leader generates an API
-- key here; the CRM uses it server-to-server to manage lines, link its agents
-- to operators, issue station tickets and pre-authorize manual calls. The key
-- and the webhook secret are never stored in clear text.
CREATE TABLE IF NOT EXISTS crm_integrations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'franco' CHECK (kind IN ('franco')),
  name TEXT NOT NULL,
  public_id TEXT NOT NULL UNIQUE,
  api_key_prefix TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT[] NOT NULL DEFAULT ARRAY['calls', 'numbers:read', 'numbers:write', 'agents', 'webhooks']::text[],
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  webhook_url TEXT,
  webhook_secret_ciphertext TEXT,
  allowed_origins TEXT[] NOT NULL DEFAULT '{}'::text[],
  external_account_id TEXT,
  connected_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS crm_integrations_tenant_idx ON crm_integrations (tenant_id, created_at DESC);

-- Which ZapLiga operator answers for each CRM user. `provisioned` marks
-- memberships the integration created itself (and may release on unlink).
CREATE TABLE IF NOT EXISTS crm_integration_agents (
  integration_id TEXT NOT NULL REFERENCES crm_integrations(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_user_id TEXT NOT NULL,
  sdr_id TEXT NOT NULL REFERENCES sdrs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provisioned BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (integration_id, external_user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS crm_integration_agents_sdr_idx ON crm_integration_agents (integration_id, sdr_id);

-- A station opened through an integration ticket is manual-only: the
-- automatic dialer never hands it a blind call.
ALTER TABLE websocket_tickets ADD COLUMN IF NOT EXISTS integration_id TEXT REFERENCES crm_integrations(id) ON DELETE CASCADE;
ALTER TABLE sdrs ADD COLUMN IF NOT EXISTS station_mode TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE sdrs DROP CONSTRAINT IF EXISTS sdrs_station_mode_check;
ALTER TABLE sdrs ADD CONSTRAINT sdrs_station_mode_check CHECK (station_mode IN ('standard', 'manual_only'));

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS integration_id TEXT REFERENCES crm_integrations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS external_ref JSONB;
CREATE INDEX IF NOT EXISTS calls_integration_idx ON calls (integration_id, created_at DESC) WHERE integration_id IS NOT NULL;

-- Commercial gate: same tier as the lead ingestion API (Growth and up).
ALTER TABLE tenant_feature_flags ADD COLUMN IF NOT EXISTS crm_integration BOOLEAN NOT NULL DEFAULT false;

UPDATE billing_plan_versions
SET feature_entitlements = feature_entitlements || jsonb_build_object('crm_integration', CASE WHEN code = 'starter' THEN 'none' ELSE 'full' END),
    updated_at = now()
WHERE code IN ('starter', 'growth', 'pro');

-- Entitlement snapshots of tenants already on a plan are frozen until the next
-- recompute; extend them now so existing Growth/Pro tenants get the feature.
UPDATE tenant_entitlements
SET feature_entitlements = feature_entitlements || '{"crm_integration":"full"}'::jsonb
WHERE feature_entitlements->>'lead_ingestion_api' = 'full';

UPDATE tenant_entitlements
SET last_active_feature_entitlements = last_active_feature_entitlements || '{"crm_integration":"full"}'::jsonb
WHERE last_active_feature_entitlements->>'lead_ingestion_api' = 'full';
