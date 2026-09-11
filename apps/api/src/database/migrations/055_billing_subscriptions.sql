-- Billing projection and tenant entitlements. Stripe is the financial source of
-- truth; these tables are the local, auditable projection used by request and
-- dialer authorization.

CREATE TABLE IF NOT EXISTS billing_plan_versions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  version INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  max_sdrs INTEGER NOT NULL CHECK (max_sdrs > 0 AND max_sdrs <= 100000),
  entitlements JSONB NOT NULL DEFAULT '{}'::jsonb,
  effective_from TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (code, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS billing_plan_versions_active_code_idx
  ON billing_plan_versions (code) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS billing_plan_prices (
  id TEXT PRIMARY KEY,
  plan_version_id TEXT NOT NULL REFERENCES billing_plan_versions(id) ON DELETE RESTRICT,
  stripe_price_id TEXT NOT NULL,
  livemode BOOLEAN NOT NULL DEFAULT false,
  currency TEXT NOT NULL,
  unit_amount INTEGER NOT NULL CHECK (unit_amount >= 0),
  billing_interval TEXT NOT NULL CHECK (billing_interval IN ('day', 'week', 'month', 'year')),
  interval_count INTEGER NOT NULL DEFAULT 1 CHECK (interval_count > 0),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (stripe_price_id, livemode)
);

CREATE INDEX IF NOT EXISTS billing_plan_prices_lookup_idx
  ON billing_plan_prices (livemode, active, stripe_price_id);

CREATE TABLE IF NOT EXISTS tenant_billing_accounts (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL,
  billing_email TEXT,
  livemode BOOLEAN NOT NULL DEFAULT false,
  last_reconciled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, livemode),
  UNIQUE (stripe_customer_id, livemode)
);

CREATE TABLE IF NOT EXISTS tenant_subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'stripe' CHECK (provider = 'stripe'),
  stripe_subscription_id TEXT NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  stripe_price_id TEXT,
  plan_version_id TEXT REFERENCES billing_plan_versions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')),
  livemode BOOLEAN NOT NULL DEFAULT false,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  trial_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  canceled_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  latest_invoice_id TEXT,
  latest_invoice_status TEXT,
  access_until TIMESTAMPTZ,
  last_provider_event_id TEXT,
  provider_updated_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (stripe_subscription_id, livemode)
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_one_open_subscription_idx
  ON tenant_subscriptions (tenant_id, livemode)
  WHERE ended_at IS NULL AND status NOT IN ('canceled', 'incomplete_expired');

CREATE INDEX IF NOT EXISTS tenant_subscriptions_tenant_status_idx
  ON tenant_subscriptions (tenant_id, status, access_until);

CREATE TABLE IF NOT EXISTS tenant_entitlements (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  plan_version_id TEXT REFERENCES billing_plan_versions(id) ON DELETE RESTRICT,
  access_mode TEXT NOT NULL DEFAULT 'read_only' CHECK (access_mode IN ('full', 'read_only', 'blocked')),
  access_reason TEXT NOT NULL DEFAULT 'no_subscription',
  access_until TIMESTAMPTZ,
  max_sdrs INTEGER CHECK (max_sdrs IS NULL OR (max_sdrs > 0 AND max_sdrs <= 100000)),
  source TEXT NOT NULL DEFAULT 'none' CHECK (source IN ('stripe', 'manual_grant', 'none')),
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_entitlements_access_idx
  ON tenant_entitlements (access_mode, access_until);

CREATE TABLE IF NOT EXISTS billing_webhook_events (
  stripe_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  object_id TEXT,
  livemode BOOLEAN NOT NULL DEFAULT false,
  api_version TEXT,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processing', 'processed', 'failed', 'dead_letter')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  payload JSONB,
  UNIQUE (event_type, object_id, stripe_event_id)
);

CREATE INDEX IF NOT EXISTS billing_webhook_events_queue_idx
  ON billing_webhook_events (status, next_attempt_at, received_at);

CREATE INDEX IF NOT EXISTS billing_webhook_events_object_idx
  ON billing_webhook_events (event_type, object_id, received_at DESC);

CREATE TABLE IF NOT EXISTS billing_manual_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  max_sdrs INTEGER NOT NULL CHECK (max_sdrs > 0 AND max_sdrs <= 100000),
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  revoked_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > starts_at)
);

CREATE INDEX IF NOT EXISTS billing_manual_grants_active_idx
  ON billing_manual_grants (tenant_id, starts_at, expires_at)
  WHERE revoked_at IS NULL;

-- Prevent two concurrent SDR invitations for the same organization/e-mail from
-- consuming quota twice. Expired/revoked/accepted invitations are reusable.
CREATE UNIQUE INDEX IF NOT EXISTS invitations_pending_sdr_email_idx
  ON invitations (tenant_id, lower(invited_email))
  WHERE role = 'sdr' AND accepted_at IS NULL AND revoked_at IS NULL;

-- Existing tenants start in an explicit read-only/no-subscription state. The
-- rollout assigns a temporary manual grant or a real subscription before
-- enabling enforcement, so this migration never invents commercial limits.
INSERT INTO tenant_entitlements (tenant_id, access_mode, access_reason, source)
SELECT t.id, 'read_only', 'no_subscription', 'none'
FROM tenants t
ON CONFLICT (tenant_id) DO NOTHING;
