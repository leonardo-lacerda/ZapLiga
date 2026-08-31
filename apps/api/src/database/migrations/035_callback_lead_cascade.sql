-- Pending callbacks are checked by the lead deletion services before the lead
-- is removed. Historical callbacks may safely follow the lead on deletion;
-- their call references already use SET NULL and audit events remain intact.
ALTER TABLE lead_callbacks DROP CONSTRAINT IF EXISTS lead_callbacks_lead_id_fkey;
ALTER TABLE lead_callbacks
  ADD CONSTRAINT lead_callbacks_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
