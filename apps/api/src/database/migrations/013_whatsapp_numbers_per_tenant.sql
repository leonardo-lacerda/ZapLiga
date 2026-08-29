-- Retire the global WhatsApp number pool introduced in 009. Numbers are owned by
-- a single tenant again: each organization connects and manages its own lines,
-- and the dialer only ever picks from the numbers of the tenant it is dialing for.

-- Disconnect every number that is still in the global pool (tenant_id IS NULL).
-- They leave the dialer immediately (its selection filters on status); each
-- organization reconnects its own lines from scratch under the new flow.
UPDATE whatsapp_numbers SET status = 'removed' WHERE tenant_id IS NULL AND status <> 'removed';

-- Restore tenant-ownership integrity. New rows must reference a real tenant; the
-- column stays nullable only so the retired legacy rows above remain valid (a
-- NULL tenant_id is skipped by the foreign key).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_numbers_tenant_fk') THEN
    ALTER TABLE whatsapp_numbers
      ADD CONSTRAINT whatsapp_numbers_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id);
  END IF;
END $$;

-- Support the per-tenant dialer selection (tenant_id + status ordered by cooldown).
CREATE INDEX IF NOT EXISTS whatsapp_numbers_tenant_status_idx
  ON whatsapp_numbers (tenant_id, status, last_call_ended_at);
