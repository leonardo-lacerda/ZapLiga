-- Campaign execution context: bind ingestion, queue reservations and output
-- events without rewriting legacy history. Nullable values preserve the
-- existing operation until a lead is explicitly assigned to a campaign.

ALTER TABLE lead_integrations
  ADD COLUMN IF NOT EXISTS campaign_id TEXT;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS campaign_id TEXT,
  ADD COLUMN IF NOT EXISTS campaign_version INTEGER;

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS campaign_id TEXT,
  ADD COLUMN IF NOT EXISTS campaign_version INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_integrations_tenant_campaign_fk') THEN
    ALTER TABLE lead_integrations
      ADD CONSTRAINT lead_integrations_tenant_campaign_fk
      FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns (tenant_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_tenant_campaign_fk') THEN
    ALTER TABLE leads
      ADD CONSTRAINT leads_tenant_campaign_fk
      FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns (tenant_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calls_tenant_campaign_fk') THEN
    ALTER TABLE calls
      ADD CONSTRAINT calls_tenant_campaign_fk
      FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns (tenant_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_campaign_version_pair_check') THEN
    ALTER TABLE leads ADD CONSTRAINT leads_campaign_version_pair_check
      CHECK ((campaign_id IS NULL) = (campaign_version IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calls_campaign_version_pair_check') THEN
    ALTER TABLE calls ADD CONSTRAINT calls_campaign_version_pair_check
      CHECK ((campaign_id IS NULL) = (campaign_version IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calls_tenant_campaign_version_fk') THEN
    ALTER TABLE calls
      ADD CONSTRAINT calls_tenant_campaign_version_fk
      FOREIGN KEY (tenant_id, campaign_id, campaign_version)
      REFERENCES campaign_versions (tenant_id, campaign_id, version);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_tenant_campaign_version_fk') THEN
    ALTER TABLE leads
      ADD CONSTRAINT leads_tenant_campaign_version_fk
      FOREIGN KEY (tenant_id, campaign_id, campaign_version)
      REFERENCES campaign_versions (tenant_id, campaign_id, version);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS lead_integrations_tenant_campaign_idx
  ON lead_integrations (tenant_id, campaign_id)
  WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_tenant_campaign_queue_idx
  ON leads (tenant_id, campaign_id, campaign_version, status, next_eligible_at)
  WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS calls_tenant_campaign_created_idx
  ON calls (tenant_id, campaign_id, campaign_version, created_at DESC)
  WHERE campaign_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS campaign_playbooks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  source_campaign_id TEXT,
  config_snapshot JSONB NOT NULL,
  config_hash TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT campaign_playbooks_tenant_source_campaign_fk
    FOREIGN KEY (tenant_id, source_campaign_id) REFERENCES campaigns (tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS campaign_playbooks_tenant_name_unique
  ON campaign_playbooks (tenant_id, lower(name));
CREATE INDEX IF NOT EXISTS campaign_playbooks_tenant_created_idx
  ON campaign_playbooks (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS campaign_event_outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id TEXT,
  campaign_version INTEGER,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT campaign_event_outbox_tenant_campaign_fk
    FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns (tenant_id, id),
  CONSTRAINT campaign_event_outbox_tenant_version_fk
    FOREIGN KEY (tenant_id, campaign_id, campaign_version)
    REFERENCES campaign_versions (tenant_id, campaign_id, version),
  CONSTRAINT campaign_event_outbox_campaign_version_check
    CHECK (campaign_version IS NULL OR campaign_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS campaign_event_outbox_pending_idx
  ON campaign_event_outbox (status, next_attempt_at, created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS campaign_event_outbox_tenant_created_idx
  ON campaign_event_outbox (tenant_id, created_at DESC);
