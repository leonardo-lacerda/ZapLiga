-- Fase 2 do plano de métricas: histórico de disponibilidade do SDR e de
-- status do número (plano seção 8.2, itens 5 e 6). Implementado via trigger
-- em vez de instrumentar cada ponto do dialer que muda `sdrs.state` /
-- `whatsapp_numbers.status` (são muitos — ver dialer.service.ts) — o trigger
-- captura toda mudança, de qualquer origem, sem tocar na lógica do discador.

CREATE TABLE IF NOT EXISTS sdr_availability_history (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id TEXT NOT NULL,
  sdr_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sdr_availability_history_tenant_sdr_idx ON sdr_availability_history (tenant_id, sdr_id, changed_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sdr_availability_history_tenant_sdr_fk') THEN
    ALTER TABLE sdr_availability_history ADD CONSTRAINT sdr_availability_history_tenant_sdr_fk FOREIGN KEY (tenant_id, sdr_id) REFERENCES sdrs (tenant_id, id) NOT VALID;
  END IF;
END $$;

INSERT INTO sdr_availability_history (tenant_id, sdr_id, from_state, to_state, changed_at)
SELECT tenant_id, id, NULL, state, created_at FROM sdrs
WHERE NOT EXISTS (SELECT 1 FROM sdr_availability_history h WHERE h.tenant_id = sdrs.tenant_id AND h.sdr_id = sdrs.id);

CREATE OR REPLACE FUNCTION record_sdr_availability_change() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    INSERT INTO sdr_availability_history (tenant_id, sdr_id, from_state, to_state) VALUES (NEW.tenant_id, NEW.id, OLD.state, NEW.state);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sdrs_availability_history_trg ON sdrs;
CREATE TRIGGER sdrs_availability_history_trg
AFTER UPDATE OF state ON sdrs
FOR EACH ROW EXECUTE FUNCTION record_sdr_availability_change();

CREATE TABLE IF NOT EXISTS number_status_history (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id TEXT NOT NULL,
  number_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS number_status_history_tenant_number_idx ON number_status_history (tenant_id, number_id, changed_at DESC);

-- whatsapp_numbers só tem `id` como chave única desde a migration 009 (o
-- pool global de números derrubou o índice único composto (tenant_id, id) e
-- nunca o recriou — calls.number_id também referencia só `id`, ver
-- 009_global_whatsapp_number_pool.sql); acompanhamos a mesma convenção aqui.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'number_status_history_number_fk') THEN
    ALTER TABLE number_status_history ADD CONSTRAINT number_status_history_number_fk FOREIGN KEY (number_id) REFERENCES whatsapp_numbers (id) NOT VALID;
  END IF;
END $$;

INSERT INTO number_status_history (tenant_id, number_id, from_status, to_status, changed_at)
SELECT tenant_id, id, NULL, status, created_at FROM whatsapp_numbers
WHERE tenant_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM number_status_history h WHERE h.tenant_id = whatsapp_numbers.tenant_id AND h.number_id = whatsapp_numbers.id);

CREATE OR REPLACE FUNCTION record_number_status_change() RETURNS TRIGGER AS $$
BEGIN
  -- tenant_id fica nulo apenas nos números legados do pool global (migration
  -- 013), que ficam presos em status = 'removed' e nunca mais mudam; o guard
  -- é só para não violar a NOT NULL da história nesse caso de borda.
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.tenant_id IS NOT NULL THEN
    INSERT INTO number_status_history (tenant_id, number_id, from_status, to_status) VALUES (NEW.tenant_id, NEW.id, OLD.status, NEW.status);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS whatsapp_numbers_status_history_trg ON whatsapp_numbers;
CREATE TRIGGER whatsapp_numbers_status_history_trg
AFTER UPDATE OF status ON whatsapp_numbers
FOR EACH ROW EXECUTE FUNCTION record_number_status_change();
