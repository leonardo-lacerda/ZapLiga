-- Contract the expanded schema and enforce tenant-consistent relationships.

ALTER TABLE leads ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE sdrs ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE whatsapp_numbers ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE calls ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE sdr_pauses ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE dialer_settings ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_phone_key;
ALTER TABLE sdrs DROP CONSTRAINT IF EXISTS sdrs_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS leads_tenant_phone_unique ON leads (tenant_id, phone);
CREATE UNIQUE INDEX IF NOT EXISTS sdrs_tenant_name_unique ON sdrs (tenant_id, name);

-- Waxum session IDs identify external sessions and remain globally unique.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_numbers_waxum_session_unique ON whatsapp_numbers (waxum_session_id);

CREATE UNIQUE INDEX IF NOT EXISTS leads_tenant_id_unique ON leads (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS sdrs_tenant_id_unique ON sdrs (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_numbers_tenant_id_unique ON whatsapp_numbers (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS calls_tenant_id_unique ON calls (tenant_id, id);

DROP INDEX IF EXISTS leads_queue_idx;
DROP INDEX IF EXISTS calls_created_idx;
DROP INDEX IF EXISTS sdr_pauses_open_idx;
DROP INDEX IF EXISTS calls_wrap_up_idx;

CREATE INDEX IF NOT EXISTS leads_tenant_queue_idx ON leads (tenant_id, status, next_eligible_at) WHERE do_not_call = false;
CREATE INDEX IF NOT EXISTS calls_tenant_created_idx ON calls (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sdrs_tenant_state_idx ON sdrs (tenant_id, state);
CREATE INDEX IF NOT EXISTS numbers_tenant_status_idx ON whatsapp_numbers (tenant_id, status);
CREATE INDEX IF NOT EXISTS sdr_pauses_tenant_open_idx ON sdr_pauses (tenant_id, sdr_id, started_at DESC) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS calls_tenant_wrap_up_idx ON calls (tenant_id, wrap_up_completed_at) WHERE connected_at IS NOT NULL;

ALTER TABLE dialer_settings DROP CONSTRAINT IF EXISTS dialer_settings_pkey;
ALTER TABLE dialer_settings ADD CONSTRAINT dialer_settings_pkey PRIMARY KEY (tenant_id);
ALTER TABLE dialer_settings DROP COLUMN IF EXISTS id;

ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_lead_id_fkey;
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_number_id_fkey;
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_sdr_id_fkey;
ALTER TABLE sdr_pauses DROP CONSTRAINT IF EXISTS sdr_pauses_sdr_id_fkey;
ALTER TABLE sdr_pauses DROP CONSTRAINT IF EXISTS sdr_pauses_call_id_fkey;

ALTER TABLE calls
  ADD CONSTRAINT calls_tenant_lead_fk FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id) NOT VALID,
  ADD CONSTRAINT calls_tenant_number_fk FOREIGN KEY (tenant_id, number_id) REFERENCES whatsapp_numbers (tenant_id, id) NOT VALID,
  ADD CONSTRAINT calls_tenant_sdr_fk FOREIGN KEY (tenant_id, sdr_id) REFERENCES sdrs (tenant_id, id) NOT VALID;

ALTER TABLE sdr_pauses
  ADD CONSTRAINT sdr_pauses_tenant_sdr_fk FOREIGN KEY (tenant_id, sdr_id) REFERENCES sdrs (tenant_id, id) NOT VALID,
  ADD CONSTRAINT sdr_pauses_tenant_call_fk FOREIGN KEY (tenant_id, call_id) REFERENCES calls (tenant_id, id) NOT VALID;

ALTER TABLE leads VALIDATE CONSTRAINT leads_tenant_fk;
ALTER TABLE sdrs VALIDATE CONSTRAINT sdrs_tenant_fk;
ALTER TABLE whatsapp_numbers VALIDATE CONSTRAINT whatsapp_numbers_tenant_fk;
ALTER TABLE calls VALIDATE CONSTRAINT calls_tenant_fk;
ALTER TABLE sdr_pauses VALIDATE CONSTRAINT sdr_pauses_tenant_fk;
ALTER TABLE dialer_settings VALIDATE CONSTRAINT dialer_settings_tenant_fk;
ALTER TABLE calls VALIDATE CONSTRAINT calls_tenant_lead_fk;
ALTER TABLE calls VALIDATE CONSTRAINT calls_tenant_number_fk;
ALTER TABLE calls VALIDATE CONSTRAINT calls_tenant_sdr_fk;
ALTER TABLE sdr_pauses VALIDATE CONSTRAINT sdr_pauses_tenant_sdr_fk;
ALTER TABLE sdr_pauses VALIDATE CONSTRAINT sdr_pauses_tenant_call_fk;
