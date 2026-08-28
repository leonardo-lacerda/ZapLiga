-- Per-tenant safety quotas. Values can be raised by an operator after review.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS max_leads INTEGER NOT NULL DEFAULT 100000;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS max_numbers INTEGER NOT NULL DEFAULT 50;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS max_sdrs INTEGER NOT NULL DEFAULT 500;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_max_leads_check') THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_max_leads_check CHECK (max_leads > 0 AND max_leads <= 10000000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_max_numbers_check') THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_max_numbers_check CHECK (max_numbers > 0 AND max_numbers <= 10000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_max_sdrs_check') THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_max_sdrs_check CHECK (max_sdrs > 0 AND max_sdrs <= 100000);
  END IF;
END $$;
