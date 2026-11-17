-- WhatsApp provisioning on GeeLark cloud phones (internal operation feature).
-- Contract: docs/provisioning-contract.md. The SMS code and the pairing code
-- are never stored here: they only travel in memory between web, API and the
-- geelark-worker.

-- Internal feature: opt-in, no paid plan grants it; only the super admin toggle does.
ALTER TABLE tenant_feature_flags ADD COLUMN IF NOT EXISTS whatsapp_provisioning BOOLEAN NOT NULL DEFAULT false;

-- API-side copy of each worker job (same id on both sides). The worker keeps the
-- live state; GET jobs/:id syncs this snapshot. `number_id` is the line created
-- when the operator chose to connect it to ZapLiga by pairing code.
CREATE TABLE IF NOT EXISTS provisioning_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  -- Id of the attendant PC (egress_pcs.id) the phone went out through; its slot may change.
  egress_node TEXT NOT NULL,
  geelark_phone_id TEXT NOT NULL,
  phone_name TEXT,
  app TEXT NOT NULL CHECK (app IN ('whatsapp', 'business')),
  phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'waiting_input', 'done', 'failed', 'cancelled')),
  step TEXT NOT NULL DEFAULT 'queued',
  awaiting TEXT CHECK (awaiting IS NULL OR awaiting IN ('sms', 'profile', 'link_decision', 'pair_code')),
  message TEXT,
  error_code TEXT,
  egress_ip TEXT,
  has_screenshot BOOLEAN NOT NULL DEFAULT false,
  history JSONB NOT NULL DEFAULT '[]'::jsonb,
  linked BOOLEAN NOT NULL DEFAULT false,
  -- On the link path the worker leaves the phone on (the primary device must stay
  -- online until Waxum reports connected); the API powers it off afterwards.
  power_off_when_done BOOLEAN NOT NULL DEFAULT true,
  number_id TEXT REFERENCES whatsapp_numbers(id) ON DELETE SET NULL,
  link_started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS provisioning_jobs_tenant_idx ON provisioning_jobs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS provisioning_jobs_open_idx ON provisioning_jobs (tenant_id, updated_at) WHERE finished_at IS NULL;

-- Which person of the operation answers for each attendant PC used as the egress
-- (docs/saida-pelo-pc-do-atendente.md). `node_name` is the PC id (egress_pcs.id);
-- no foreign key, so removing a PC in the admin never fails on this table.
CREATE TABLE IF NOT EXISTS provisioning_egress_nodes (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  node_name TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, node_name)
);
