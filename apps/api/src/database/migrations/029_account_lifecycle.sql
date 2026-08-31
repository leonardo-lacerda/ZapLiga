ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS force_password_change BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS user_action_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  requested_ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_action_tokens_user_purpose_idx
  ON user_action_tokens (user_id, purpose, created_at DESC);
CREATE INDEX IF NOT EXISTS user_action_tokens_active_idx
  ON user_action_tokens (token_hash, purpose, expires_at) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS legal_document_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type TEXT NOT NULL CHECK (document_type IN ('terms', 'privacy')),
  version TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL,
  retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_type, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS legal_document_versions_current_idx
  ON legal_document_versions (document_type) WHERE retired_at IS NULL;

CREATE TABLE IF NOT EXISTS user_legal_acceptances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  legal_document_version_id UUID NOT NULL REFERENCES legal_document_versions(id),
  ip_address TEXT,
  user_agent TEXT,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, legal_document_version_id)
);

CREATE INDEX IF NOT EXISTS user_legal_acceptances_user_idx ON user_legal_acceptances (user_id, accepted_at DESC);
CREATE INDEX IF NOT EXISTS user_sessions_sid_validation_idx ON user_sessions (id, user_id, expires_at, revoked_at);

INSERT INTO legal_document_versions (document_type, version, title, url, effective_at)
VALUES
  ('terms', '2026-08-30', 'Termos de Uso', '/termos', TIMESTAMPTZ '2026-08-30 00:00:00-03'),
  ('privacy', '2026-08-30', 'Política de Privacidade', '/privacidade', TIMESTAMPTZ '2026-08-30 00:00:00-03')
ON CONFLICT (document_type, version) DO NOTHING;
