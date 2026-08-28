-- WhatsApp numbers are platform resources shared by every tenant.
-- Keep the legacy column for compatibility, but remove tenant ownership.
ALTER TABLE whatsapp_numbers ALTER COLUMN tenant_id DROP NOT NULL;

-- Remove the old composite reference before clearing tenant ownership.
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_tenant_number_fk;
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_number_fk;

ALTER TABLE whatsapp_numbers DROP CONSTRAINT IF EXISTS whatsapp_numbers_tenant_fk;
UPDATE whatsapp_numbers SET tenant_id = NULL;
DROP INDEX IF EXISTS whatsapp_numbers_tenant_id_unique;

-- Calls remain tenant-owned through their leads and SDRs, while the number
-- resource itself is referenced globally by its primary key.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calls_number_fk') THEN
    ALTER TABLE calls
      ADD CONSTRAINT calls_number_fk FOREIGN KEY (number_id) REFERENCES whatsapp_numbers(id) NOT VALID;
  END IF;
END $$;

ALTER TABLE calls VALIDATE CONSTRAINT calls_number_fk;

CREATE INDEX IF NOT EXISTS whatsapp_numbers_status_idx ON whatsapp_numbers (status, last_call_ended_at);
