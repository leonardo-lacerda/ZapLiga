ALTER TABLE invitations ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'queued' CHECK (delivery_status IN ('queued', 'sent', 'failed'));
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS delivery_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS delivery_error TEXT;
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS tenant_onboarding_steps (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  step TEXT NOT NULL CHECK (step IN ('audio_tested')),
  completed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, step)
);

CREATE TABLE IF NOT EXISTS data_subject_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_type TEXT NOT NULL CHECK (request_type IN ('correction', 'anonymization', 'deletion', 'export')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'processing', 'completed', 'rejected', 'cancelled')),
  subject_phone_hash TEXT NOT NULL,
  subject_phone_encrypted TEXT NOT NULL,
  requested_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  assigned_to_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  details TEXT,
  due_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '15 days'),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS data_subject_requests_tenant_status_due_idx ON data_subject_requests (tenant_id, status, due_at);
CREATE INDEX IF NOT EXISTS data_subject_requests_tenant_phone_idx ON data_subject_requests (tenant_id, subject_phone_hash);

CREATE TABLE IF NOT EXISTS data_subject_request_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES data_subject_requests(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS data_subject_request_events_request_idx ON data_subject_request_events (request_id, created_at);

CREATE TABLE IF NOT EXISTS data_subject_exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES data_subject_requests(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
  downloaded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (request_id)
);
