-- Fase 2 do plano de métricas: persiste o catálogo comercial (antes só
-- existia como constante no frontend / em metrics.definitions.ts) para que
-- cada organização possa, no futuro, customizá-lo (plano seção 6.7).
-- Os valores atuais são semeados para todo tenant existente e para todo
-- tenant novo (trigger em `tenants`), mantendo o comportamento de hoje.
--
-- Decisão: `calls.call_result`/`calls.pipeline_stage`/`leads.pipeline_stage`
-- continuam TEXT livre, sem FK para estas tabelas. Um valor fora do catálogo
-- viraria uma violação de FK (erro 500 cru) no fluxo de pós-atendimento do
-- SDR em vez de um 400 tratado — a validação fica na camada de aplicação
-- (FinishPauseDto, ver apps/api/src/modules/sdrs/dto/finish-pause.dto.ts) e
-- desvios são detectados depois via MetricsConsistencyService.check().

CREATE TABLE IF NOT EXISTS call_result_catalog (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  label TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('positive', 'neutral', 'negative', 'conversion')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS pipeline_stage_catalog (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_conversion BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE OR REPLACE FUNCTION seed_default_metrics_catalog(target_tenant_id TEXT) RETURNS void AS $$
BEGIN
  INSERT INTO call_result_catalog (tenant_id, id, label, classification, sort_order) VALUES
    (target_tenant_id, 'reuniao_agendada', 'Reunião agendada', 'conversion', 0),
    (target_tenant_id, 'interessado', 'Interessado', 'positive', 1),
    (target_tenant_id, 'retornar', 'Solicitou retorno', 'neutral', 2),
    (target_tenant_id, 'sem_interesse', 'Sem interesse', 'negative', 3),
    (target_tenant_id, 'numero_invalido', 'Número inválido', 'negative', 4)
  ON CONFLICT (tenant_id, id) DO NOTHING;

  INSERT INTO pipeline_stage_catalog (tenant_id, id, label, sort_order, is_conversion) VALUES
    (target_tenant_id, 'novo', 'Novo', 0, false),
    (target_tenant_id, 'contatado', 'Contatado', 1, false),
    (target_tenant_id, 'qualificado', 'Qualificado', 2, false),
    (target_tenant_id, 'reuniao', 'Reunião', 3, false),
    (target_tenant_id, 'ganho', 'Ganho', 4, true),
    (target_tenant_id, 'perdido', 'Perdido', 5, false)
  ON CONFLICT (tenant_id, id) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE tenant_row RECORD;
BEGIN
  FOR tenant_row IN SELECT id FROM tenants LOOP
    PERFORM seed_default_metrics_catalog(tenant_row.id);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION seed_metrics_catalog_for_new_tenant() RETURNS TRIGGER AS $$
BEGIN
  PERFORM seed_default_metrics_catalog(NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tenants_seed_metrics_catalog_trg ON tenants;
CREATE TRIGGER tenants_seed_metrics_catalog_trg
AFTER INSERT ON tenants
FOR EACH ROW EXECUTE FUNCTION seed_metrics_catalog_for_new_tenant();
