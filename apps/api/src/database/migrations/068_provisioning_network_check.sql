-- Cloud phones created from ZapLiga already go out through an attendant PC; an
-- "internet test" job applies the PC's proxy, starts the phone, checks the IP seen
-- inside it and powers it off. It reuses provisioning_jobs with no app or number.
ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'register';
DO $$ BEGIN
  ALTER TABLE provisioning_jobs ADD CONSTRAINT provisioning_jobs_mode_check CHECK (mode IN ('register', 'network_check'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- The existing CHECK on app accepts NULL; a network check has neither app nor number.
ALTER TABLE provisioning_jobs ALTER COLUMN app DROP NOT NULL;
ALTER TABLE provisioning_jobs ALTER COLUMN phone DROP NOT NULL;
DO $$ BEGIN
  ALTER TABLE provisioning_jobs ADD CONSTRAINT provisioning_jobs_register_fields_check
    CHECK (mode <> 'register' OR (app IS NOT NULL AND phone IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
