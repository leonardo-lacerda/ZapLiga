CREATE TABLE IF NOT EXISTS lead_callbacks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
  origin_call_id TEXT REFERENCES calls(id) ON DELETE SET NULL,
  requested_by_sdr_id TEXT REFERENCES sdrs(id) ON DELETE SET NULL,
  assigned_sdr_id TEXT REFERENCES sdrs(id) ON DELETE SET NULL,
  due_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'due', 'completed', 'cancelled', 'missed', 'reassigned')),
  notes TEXT,
  completed_call_id TEXT REFERENCES calls(id) ON DELETE SET NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS lead_callbacks_one_active_per_lead_idx
  ON lead_callbacks (tenant_id, lead_id) WHERE status IN ('pending', 'due', 'reassigned');
CREATE INDEX IF NOT EXISTS lead_callbacks_tenant_due_idx ON lead_callbacks (tenant_id, status, due_at);
CREATE INDEX IF NOT EXISTS lead_callbacks_sdr_due_idx ON lead_callbacks (tenant_id, assigned_sdr_id, status, due_at);
