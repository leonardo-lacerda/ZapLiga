-- Administrative billing actions need an explicit source and reason so that
-- support-led changes remain auditable and distinguishable from self-service.
ALTER TABLE tenant_billing_changes
  ADD COLUMN IF NOT EXISTS requested_source TEXT NOT NULL DEFAULT 'organization',
  ADD COLUMN IF NOT EXISTS request_reason TEXT;

ALTER TABLE tenant_billing_changes
  DROP CONSTRAINT IF EXISTS tenant_billing_changes_requested_source_check;

ALTER TABLE tenant_billing_changes
  ADD CONSTRAINT tenant_billing_changes_requested_source_check
  CHECK (requested_source IN ('organization', 'admin'));

CREATE INDEX IF NOT EXISTS tenant_billing_changes_source_idx
  ON tenant_billing_changes (tenant_id, requested_source, created_at DESC);
