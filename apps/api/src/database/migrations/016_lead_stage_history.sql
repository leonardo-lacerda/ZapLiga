-- Fase 2 do plano de métricas: histórico de etapa do lead (plano seção 8.3).
-- `leads.pipeline_stage` só guarda o estado atual; esta tabela guarda cada
-- transição para permitir "avanço de etapa" como métrica histórica real.

CREATE TABLE IF NOT EXISTS lead_stage_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  from_stage TEXT,
  to_stage TEXT NOT NULL,
  source TEXT NOT NULL,
  call_id TEXT,
  changed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_stage_history_tenant_lead_idx ON lead_stage_history (tenant_id, lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lead_stage_history_tenant_created_idx ON lead_stage_history (tenant_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_stage_history_tenant_lead_fk') THEN
    ALTER TABLE lead_stage_history ADD CONSTRAINT lead_stage_history_tenant_lead_fk FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_stage_history_tenant_call_fk') THEN
    ALTER TABLE lead_stage_history ADD CONSTRAINT lead_stage_history_tenant_call_fk FOREIGN KEY (tenant_id, call_id) REFERENCES calls (tenant_id, id) NOT VALID;
  END IF;
END $$;

-- Backfill: não temos o histórico real de transições anteriores a esta
-- migração, então registramos apenas o que é honesto inferir — a etapa atual
-- de cada lead, na data de criação do lead (plano seção 8.3: "a primeira
-- etapa deve ser registrada na criação do lead").
INSERT INTO lead_stage_history (id, tenant_id, lead_id, from_stage, to_stage, source, created_at)
SELECT gen_random_uuid()::text, tenant_id, id, NULL, pipeline_stage, 'backfill', created_at
FROM leads
WHERE NOT EXISTS (SELECT 1 FROM lead_stage_history h WHERE h.tenant_id = leads.tenant_id AND h.lead_id = leads.id);

-- A partir de agora, todo novo lead grava sua etapa inicial automaticamente.
-- Um upsert (ON CONFLICT DO UPDATE) não é um INSERT novo e não dispara isto,
-- o que é o comportamento correto (o lead já existia).
CREATE OR REPLACE FUNCTION record_lead_stage_creation() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO lead_stage_history (id, tenant_id, lead_id, from_stage, to_stage, source, created_at)
  VALUES (gen_random_uuid()::text, NEW.tenant_id, NEW.id, NULL, NEW.pipeline_stage, 'lead_created', NEW.created_at);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS leads_stage_creation_trg ON leads;
CREATE TRIGGER leads_stage_creation_trg
AFTER INSERT ON leads
FOR EACH ROW EXECUTE FUNCTION record_lead_stage_creation();
