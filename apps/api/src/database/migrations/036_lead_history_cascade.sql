-- Lead and call history are tenant-owned lifecycle data. Removing a lead or
-- call must not fail because an audit-style stage-history row still points at
-- it; the canonical audit log remains the durable operational trail.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_stage_history_tenant_lead_fk') THEN
    ALTER TABLE lead_stage_history DROP CONSTRAINT lead_stage_history_tenant_lead_fk;
  END IF;
  ALTER TABLE lead_stage_history
    ADD CONSTRAINT lead_stage_history_tenant_lead_fk
    FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id) ON DELETE CASCADE;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_stage_history_tenant_call_fk') THEN
    ALTER TABLE lead_stage_history DROP CONSTRAINT lead_stage_history_tenant_call_fk;
  END IF;
  ALTER TABLE lead_stage_history
    ADD CONSTRAINT lead_stage_history_tenant_call_fk
    FOREIGN KEY (tenant_id, call_id) REFERENCES calls (tenant_id, id) ON DELETE CASCADE;
END $$;
