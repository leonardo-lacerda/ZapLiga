ALTER TABLE tenant_billing_changes
  ADD COLUMN IF NOT EXISTS to_plan_version_id TEXT REFERENCES billing_plan_versions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS to_base_price_id TEXT,
  ADD COLUMN IF NOT EXISTS to_seat_price_id TEXT,
  ADD COLUMN IF NOT EXISTS to_seat_quantity INTEGER CHECK (to_seat_quantity IS NULL OR to_seat_quantity >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_billing_changes_one_pending_idx
  ON tenant_billing_changes (tenant_id)
  WHERE status IN ('pending_payment', 'scheduled');
