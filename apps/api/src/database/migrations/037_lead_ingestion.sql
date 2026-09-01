-- Entrada automática de leads: integrações, eventos idempotentes e outbox durável.
CREATE TABLE IF NOT EXISTS lead_integrations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  public_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  integration_type TEXT NOT NULL DEFAULT 'webhook' CHECK (integration_type IN ('webhook', 'api', 'automation')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  default_folder_id TEXT NOT NULL,
  duplicate_policy TEXT NOT NULL DEFAULT 'update_existing' CHECK (duplicate_policy IN ('update_existing', 'ignore_duplicate', 'reject_duplicate')),
  default_priority INTEGER NOT NULL DEFAULT 0 CHECK (default_priority BETWEEN -100 AND 100),
  field_mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
  api_key_prefix TEXT NOT NULL,
  api_key_hash TEXT NOT NULL,
  signing_secret_ciphertext TEXT,
  last_received_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error_at TIMESTAMPTZ,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (tenant_id, id),
  CONSTRAINT lead_integrations_tenant_folder_fk
    FOREIGN KEY (tenant_id, default_folder_id) REFERENCES lead_folders (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS lead_integrations_tenant_status_idx
  ON lead_integrations (tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS lead_ingestion_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  external_event_id TEXT,
  payload_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processing', 'accepted', 'updated', 'duplicate', 'rejected', 'failed', 'dead_letter')),
  lead_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_code TEXT,
  error_message TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  UNIQUE (integration_id, idempotency_key),
  UNIQUE (tenant_id, id),
  CONSTRAINT lead_ingestion_events_tenant_integration_fk
    FOREIGN KEY (tenant_id, integration_id) REFERENCES lead_integrations (tenant_id, id),
  CONSTRAINT lead_ingestion_events_tenant_lead_fk
    FOREIGN KEY (lead_id) REFERENCES leads (id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS lead_ingestion_external_event_unique
  ON lead_ingestion_events (integration_id, external_event_id)
  WHERE external_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS lead_ingestion_events_tenant_status_idx
  ON lead_ingestion_events (tenant_id, status, received_at DESC);
CREATE INDEX IF NOT EXISTS lead_ingestion_events_integration_created_idx
  ON lead_ingestion_events (integration_id, received_at DESC);

CREATE TABLE IF NOT EXISTS lead_ingestion_outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_ingestion_outbox_pending_idx
  ON lead_ingestion_outbox (status, next_attempt_at, created_at)
  WHERE status = 'pending';

CREATE SEQUENCE IF NOT EXISTS lead_queue_sequence;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS source_integration_id TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS external_id TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS queue_priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE leads ADD COLUMN IF NOT EXISTS queue_sequence BIGINT NOT NULL DEFAULT nextval('lead_queue_sequence');
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_ingestion_event_id TEXT;

WITH ordered_leads AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC)::bigint AS sequence_value
  FROM leads
)
UPDATE leads AS l
SET queue_sequence = ordered_leads.sequence_value
FROM ordered_leads
WHERE l.id = ordered_leads.id;
SELECT setval('lead_queue_sequence', GREATEST(COALESCE((SELECT max(queue_sequence) FROM leads), 0), 1), true);

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_queue_priority_check;
ALTER TABLE leads ADD CONSTRAINT leads_queue_priority_check CHECK (queue_priority BETWEEN -100 AND 100);

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_tenant_integration_fk;
ALTER TABLE leads ADD CONSTRAINT leads_source_integration_fk
  FOREIGN KEY (source_integration_id) REFERENCES lead_integrations (id) ON DELETE SET NULL;
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_tenant_ingestion_event_fk;
ALTER TABLE leads ADD CONSTRAINT leads_tenant_ingestion_event_fk
  FOREIGN KEY (last_ingestion_event_id) REFERENCES lead_ingestion_events (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS leads_tenant_integration_external_idx
  ON leads (tenant_id, source_integration_id, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_tenant_queue_priority_idx
  ON leads (tenant_id, queue_priority DESC, next_eligible_at, queue_sequence)
  WHERE do_not_call = false;

ALTER TABLE dialer_settings ADD COLUMN IF NOT EXISTS queue_strategy TEXT NOT NULL DEFAULT 'fifo';
ALTER TABLE dialer_settings DROP CONSTRAINT IF EXISTS dialer_settings_queue_strategy_check;
ALTER TABLE dialer_settings ADD CONSTRAINT dialer_settings_queue_strategy_check
  CHECK (queue_strategy IN ('fifo', 'lifo', 'priority_fifo'));
