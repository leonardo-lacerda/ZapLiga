-- Events ZapLiga pushes to a CRM integration's webhook (contract v1): call
-- lifecycle and line status. Unlike the analytics outbound webhooks these carry
-- the call's phone and names, and only ever go to the integration that placed
-- the call (or, for lines, to the tenant's own integrations).
CREATE TABLE IF NOT EXISTS crm_integration_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL REFERENCES crm_integrations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Claim lease: an instance delivering the event holds it until this time, so
  -- api-a and api-b never post the same event concurrently.
  locked_until TIMESTAMPTZ,
  last_status_code INTEGER,
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (integration_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS crm_integration_events_due_idx ON crm_integration_events (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS crm_integration_events_integration_idx ON crm_integration_events (integration_id, created_at DESC);

ALTER TABLE crm_integrations
  ADD COLUMN IF NOT EXISTS last_delivery_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_delivery_failure_at TIMESTAMPTZ;
