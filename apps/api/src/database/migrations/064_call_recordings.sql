-- Call recordings and their transcripts (docs/plano-gravacao-transcricao.md).
-- Both legs are spooled to a volume shared by api-a and api-b, so any instance
-- can encode, transcribe and serve a recording.
CREATE TABLE IF NOT EXISTS call_recordings (
  call_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- pending: legs spooled, not encoded yet; stored: Ogg/Opus written to file_path.
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'stored', 'failed')),
  duration_seconds INTEGER NOT NULL,
  file_path TEXT,
  size_bytes BIGINT,
  stored_at TIMESTAMPTZ,
  -- NULL until stored; skipped when the call is too short to transcribe.
  transcript_status TEXT CHECK (transcript_status IN ('pending', 'done', 'skipped', 'failed')),
  transcript JSONB,
  transcribed_at TIMESTAMPTZ,
  -- Retry state of the current stage (encode, then transcription).
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS call_recordings_due_idx ON call_recordings (next_attempt_at) WHERE status = 'pending' OR transcript_status = 'pending';
CREATE INDEX IF NOT EXISTS call_recordings_tenant_idx ON call_recordings (tenant_id, created_at DESC);

-- Off for every tenant: recording needs a legal basis, notice and retention policy first.
ALTER TABLE tenant_feature_flags ADD COLUMN IF NOT EXISTS call_recording BOOLEAN NOT NULL DEFAULT false;
