-- sdr_pauses.call_id referenced calls with NO ACTION, so deleting a call still
-- linked to a pause (e.g. clearing a lead folder) raised an unhandled foreign
-- key violation instead of a proper error. The pause record stays meaningful
-- after its call is gone, so let the reference go null instead of blocking.

ALTER TABLE sdr_pauses DROP CONSTRAINT IF EXISTS sdr_pauses_tenant_call_fk;
ALTER TABLE sdr_pauses
  ADD CONSTRAINT sdr_pauses_tenant_call_fk FOREIGN KEY (tenant_id, call_id) REFERENCES calls (tenant_id, id) ON DELETE SET NULL (call_id) NOT VALID;
ALTER TABLE sdr_pauses VALIDATE CONSTRAINT sdr_pauses_tenant_call_fk;
