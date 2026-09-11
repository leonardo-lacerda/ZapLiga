-- Commercial catalog, Stripe subscription items, purchased SDR seats and the
-- immutable entitlement snapshot used by authorization.  This migration is
-- additive so existing tenants remain read-only until a real subscription (or
-- an explicitly documented support grant) is present.

ALTER TABLE billing_plan_versions
  ADD COLUMN IF NOT EXISTS included_sdrs INTEGER,
  ADD COLUMN IF NOT EXISTS feature_entitlements JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS limit_entitlements JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS service_level JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Keep the legacy boolean projection compatible with the expanded commercial
-- feature catalog. Effective access is still resolved from the plan snapshot.
ALTER TABLE tenant_feature_flags
  ADD COLUMN IF NOT EXISTS lead_ingestion_api BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS advanced_reports BOOLEAN NOT NULL DEFAULT false;

UPDATE billing_plan_versions SET included_sdrs = COALESCE(included_sdrs, max_sdrs);
ALTER TABLE billing_plan_versions
  ALTER COLUMN included_sdrs SET NOT NULL;
ALTER TABLE billing_plan_versions
  DROP CONSTRAINT IF EXISTS billing_plan_versions_included_sdrs_check;
ALTER TABLE billing_plan_versions
  ADD CONSTRAINT billing_plan_versions_included_sdrs_check
  CHECK (included_sdrs > 0 AND included_sdrs <= max_sdrs);

CREATE TABLE IF NOT EXISTS billing_addon_prices (
  id TEXT PRIMARY KEY,
  addon_code TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  display_name TEXT NOT NULL,
  description TEXT,
  stripe_product_id TEXT,
  stripe_price_id TEXT NOT NULL,
  livemode BOOLEAN NOT NULL DEFAULT false,
  currency TEXT NOT NULL DEFAULT 'brl',
  unit_amount INTEGER NOT NULL CHECK (unit_amount >= 0),
  billing_interval TEXT NOT NULL CHECK (billing_interval IN ('month', 'year')),
  interval_count INTEGER NOT NULL DEFAULT 1 CHECK (interval_count > 0),
  active BOOLEAN NOT NULL DEFAULT true,
  effective_from TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (stripe_price_id, livemode),
  UNIQUE (addon_code, version, billing_interval, livemode)
);

CREATE INDEX IF NOT EXISTS billing_addon_prices_lookup_idx
  ON billing_addon_prices (addon_code, billing_interval, livemode, active);

CREATE TABLE IF NOT EXISTS tenant_subscription_items (
  id TEXT PRIMARY KEY,
  tenant_subscription_id TEXT NOT NULL REFERENCES tenant_subscriptions(id) ON DELETE CASCADE,
  stripe_subscription_item_id TEXT NOT NULL,
  stripe_price_id TEXT NOT NULL,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('base_plan', 'sdr_seat', 'other')),
  plan_version_id TEXT REFERENCES billing_plan_versions(id) ON DELETE RESTRICT,
  addon_price_id TEXT REFERENCES billing_addon_prices(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  pending_quantity INTEGER CHECK (pending_quantity IS NULL OR pending_quantity >= 0),
  livemode BOOLEAN NOT NULL DEFAULT false,
  provider_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (stripe_subscription_item_id, livemode)
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_subscription_items_one_base_idx
  ON tenant_subscription_items (tenant_subscription_id)
  WHERE item_kind = 'base_plan';
CREATE UNIQUE INDEX IF NOT EXISTS tenant_subscription_items_one_seat_idx
  ON tenant_subscription_items (tenant_subscription_id)
  WHERE item_kind = 'sdr_seat';
CREATE INDEX IF NOT EXISTS tenant_subscription_items_subscription_idx
  ON tenant_subscription_items (tenant_subscription_id, item_kind, quantity);

ALTER TABLE tenant_entitlements
  ADD COLUMN IF NOT EXISTS included_sdrs INTEGER,
  ADD COLUMN IF NOT EXISTS purchased_extra_sdrs INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS feature_entitlements JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS limit_entitlements JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_active_feature_entitlements JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS catalog_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS subscription_quantity_version BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS tenant_billing_changes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT,
  change_type TEXT NOT NULL CHECK (change_type IN ('plan_change', 'seat_change')),
  from_plan_code TEXT,
  to_plan_code TEXT,
  from_seat_quantity INTEGER,
  to_seat_quantity INTEGER,
  status TEXT NOT NULL CHECK (status IN ('previewed', 'pending_payment', 'scheduled', 'applied', 'failed', 'canceled')),
  effective_at TIMESTAMPTZ,
  idempotency_key TEXT,
  error_code TEXT,
  error_message TEXT,
  requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_billing_changes_tenant_status_idx
  ON tenant_billing_changes (tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS tenant_entitlement_overrides (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  feature_code TEXT,
  override_mode TEXT NOT NULL CHECK (override_mode IN ('grant', 'deny', 'replace_limit')),
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  revoked_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR expires_at > starts_at)
);

CREATE INDEX IF NOT EXISTS tenant_entitlement_overrides_active_idx
  ON tenant_entitlement_overrides (tenant_id, starts_at, expires_at)
  WHERE revoked_at IS NULL;

-- Operational kill-switches are deliberately separate from commercial plan
-- entitlements. A false value here is an incident/rollout control only; it
-- must never grant a feature that the plan does not include.
CREATE TABLE IF NOT EXISTS tenant_feature_controls (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  operational_flags JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Catalog definitions are seeded without Stripe price IDs. They become
-- billable when the corresponding live/test Price IDs are inserted into
-- billing_plan_prices and billing_addon_prices by the release configuration.
INSERT INTO billing_plan_versions
  (id, code, version, display_name, description, sort_order, status, max_sdrs,
   included_sdrs, feature_entitlements, limit_entitlements, service_level)
VALUES
  ('plan_starter_v1', 'starter', 1, 'Starter', 'Para equipes pequenas', 10, 'draft', 14, 5,
   '{"schedule_enforcement":"full","callbacks":"full","privacy_requests":"full","onboarding":"full","operation_health":"basic","lead_ingestion_api":"none","advanced_reports":"none"}'::jsonb,
   '{"numbers":3,"leads":25000,"retention_days":90,"max_concurrent_dialers":1}'::jsonb,
   '{"support":"standard"}'::jsonb),
  ('plan_growth_v1', 'growth', 1, 'Growth', 'Para operações em crescimento', 20, 'draft', 39, 15,
   '{"schedule_enforcement":"full","callbacks":"full","privacy_requests":"full","onboarding":"full","campaigns":"full","decision_engine":"full","recommendations":"full","operation_health":"full","lead_ingestion_api":"full","advanced_reports":"basic"}'::jsonb,
   '{"numbers":10,"leads":250000,"retention_days":365,"max_concurrent_dialers":3}'::jsonb,
   '{"support":"priority"}'::jsonb),
  ('plan_pro_v1', 'pro', 1, 'Pro', 'Para operações avançadas', 30, 'draft', 99, 40,
   '{"schedule_enforcement":"full","callbacks":"full","privacy_requests":"full","onboarding":"full","campaigns":"full","decision_engine":"full","recommendations":"full","operation_health":"full","analytics_learning":"full","experiments":"full","benchmarks":"full","lead_ingestion_api":"full","advanced_reports":"full"}'::jsonb,
   '{"numbers":30,"leads":1000000,"retention_days":730,"max_concurrent_dialers":5}'::jsonb,
   '{"support":"priority_plus"}'::jsonb)
ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  max_sdrs = EXCLUDED.max_sdrs,
  included_sdrs = EXCLUDED.included_sdrs,
  feature_entitlements = EXCLUDED.feature_entitlements,
  limit_entitlements = EXCLUDED.limit_entitlements,
  service_level = EXCLUDED.service_level,
  updated_at = now();

-- Normalize catalog copy for environments whose migration runner uses a legacy
-- Windows code page; commercial identifiers and limits remain unchanged.
UPDATE billing_plan_versions
SET description = CASE code
  WHEN 'growth' THEN 'Para operacoes em crescimento'
  WHEN 'pro' THEN 'Para operacoes avancadas'
  ELSE description
END
WHERE code IN ('growth', 'pro') AND version = 1;

-- Existing rows remain compatible with the previous boolean feature-flag
-- implementation; future code reads the new table first and uses the old row
-- only as a migration fallback.
INSERT INTO tenant_feature_controls (tenant_id)
SELECT id FROM tenants
ON CONFLICT (tenant_id) DO NOTHING;
