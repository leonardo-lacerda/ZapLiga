-- Expand and backfill the legacy operational schema.
-- The runner supplies these values from LEGACY_TENANT_* environment variables.

DO $$
DECLARE
  legacy_id TEXT := current_setting('zapcall.legacy_tenant_id', true);
  legacy_name TEXT := current_setting('zapcall.legacy_tenant_name', true);
  legacy_slug TEXT := current_setting('zapcall.legacy_tenant_slug', true);
BEGIN
  IF legacy_id IS NULL OR legacy_id = '' THEN
    RAISE EXCEPTION 'LEGACY_TENANT_ID is required';
  END IF;

  INSERT INTO tenants (id, name, slug, status)
  VALUES (legacy_id, COALESCE(NULLIF(legacy_name, ''), 'Operação legada'), COALESCE(NULLIF(legacy_slug, ''), 'operacao-legada'), 'active')
  ON CONFLICT (id) DO NOTHING;
END $$;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE sdrs ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE whatsapp_numbers ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE sdr_pauses ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE dialer_settings ADD COLUMN IF NOT EXISTS tenant_id TEXT;

DO $$
DECLARE
  legacy_id TEXT := current_setting('zapcall.legacy_tenant_id', true);
  settings_count INTEGER;
BEGIN
  UPDATE leads SET tenant_id = legacy_id WHERE tenant_id IS NULL;
  UPDATE sdrs SET tenant_id = legacy_id WHERE tenant_id IS NULL;
  UPDATE whatsapp_numbers SET tenant_id = legacy_id WHERE tenant_id IS NULL;
  UPDATE calls SET tenant_id = legacy_id WHERE tenant_id IS NULL;
  UPDATE sdr_pauses SET tenant_id = legacy_id WHERE tenant_id IS NULL;

  SELECT count(*) INTO settings_count FROM dialer_settings;
  IF settings_count > 1 THEN
    RAISE EXCEPTION 'Expected at most one legacy dialer_settings row, found %', settings_count;
  END IF;
  UPDATE dialer_settings SET tenant_id = legacy_id WHERE tenant_id IS NULL;
  IF settings_count = 0 THEN
    INSERT INTO dialer_settings (tenant_id) VALUES (legacy_id);
  END IF;

  IF EXISTS (SELECT 1 FROM leads WHERE tenant_id IS NULL)
    OR EXISTS (SELECT 1 FROM sdrs WHERE tenant_id IS NULL)
    OR EXISTS (SELECT 1 FROM whatsapp_numbers WHERE tenant_id IS NULL)
    OR EXISTS (SELECT 1 FROM calls WHERE tenant_id IS NULL)
    OR EXISTS (SELECT 1 FROM sdr_pauses WHERE tenant_id IS NULL)
    OR EXISTS (SELECT 1 FROM dialer_settings WHERE tenant_id IS NULL) THEN
    RAISE EXCEPTION 'Legacy tenant backfill left NULL tenant_id values';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_tenant_fk') THEN
    ALTER TABLE leads ADD CONSTRAINT leads_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sdrs_tenant_fk') THEN
    ALTER TABLE sdrs ADD CONSTRAINT sdrs_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_numbers_tenant_fk') THEN
    ALTER TABLE whatsapp_numbers ADD CONSTRAINT whatsapp_numbers_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calls_tenant_fk') THEN
    ALTER TABLE calls ADD CONSTRAINT calls_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sdr_pauses_tenant_fk') THEN
    ALTER TABLE sdr_pauses ADD CONSTRAINT sdr_pauses_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dialer_settings_tenant_fk') THEN
    ALTER TABLE dialer_settings ADD CONSTRAINT dialer_settings_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) NOT VALID;
  END IF;
END $$;
