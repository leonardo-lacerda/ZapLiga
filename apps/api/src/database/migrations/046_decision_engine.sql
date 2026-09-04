CREATE TABLE IF NOT EXISTS decision_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'archived')),
  weights JSONB NOT NULL DEFAULT '{}'::jsonb,
  rationale TEXT,
  config_hash TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, campaign_id, version),
  CONSTRAINT decision_policies_tenant_campaign_fk
    FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns (tenant_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS decision_policies_current_idx
  ON decision_policies (tenant_id, campaign_id)
  WHERE status = 'published';

CREATE TABLE IF NOT EXISTS decision_campaign_modes (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'shadow' CHECK (mode IN ('disabled', 'shadow', 'active')),
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, campaign_id),
  CONSTRAINT decision_campaign_modes_tenant_campaign_fk
    FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS call_decisions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  call_id TEXT,
  policy_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  mode TEXT NOT NULL CHECK (mode IN ('shadow', 'active')),
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 1000),
  reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  feature_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  fifo_position INTEGER,
  suggested_position INTEGER,
  final_decision TEXT NOT NULL CHECK (final_decision IN ('fifo', 'score', 'fallback', 'blocked')),
  evaluation_latency_ms INTEGER NOT NULL DEFAULT 0 CHECK (evaluation_latency_ms >= 0),
  dedupe_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT call_decisions_tenant_campaign_fk
    FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT call_decisions_tenant_lead_fk
    FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT call_decisions_tenant_call_fk
    FOREIGN KEY (tenant_id, call_id) REFERENCES calls (tenant_id, id) ON DELETE SET NULL,
  CONSTRAINT call_decisions_tenant_policy_fk
    FOREIGN KEY (tenant_id, policy_id) REFERENCES decision_policies (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS decision_policies_tenant_campaign_idx
  ON decision_policies (tenant_id, campaign_id, version DESC);
CREATE INDEX IF NOT EXISTS decision_modes_tenant_mode_idx
  ON decision_campaign_modes (tenant_id, mode);
CREATE INDEX IF NOT EXISTS call_decisions_tenant_campaign_created_idx
  ON call_decisions (tenant_id, campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS call_decisions_tenant_lead_created_idx
  ON call_decisions (tenant_id, lead_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS call_decisions_tenant_dedupe_idx
  ON call_decisions (tenant_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
