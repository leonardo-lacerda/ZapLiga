-- Fase 8 do plano de métricas: agregação diária materializada (plano seção
-- 13, Fase 8, item 1 — "introduzir agregações horárias e diárias") para
-- acelerar `trends()` em períodos médios/longos sem depender de fila
-- externa (não existe infraestrutura de fila neste projeto — mesma decisão
-- já tomada para exportações assíncronas na Fase 7).
--
-- Escopo deliberadamente limitado: uma única linha por (tenant, dia) só
-- serve a consulta SEM filtros (a visão padrão da tela, sem pastas/SDRs/
-- números/resultado/etapa selecionados) — servir combinações arbitrárias de
-- filtro exigiria uma linha por dimensão, multiplicando o armazenamento sem
-- necessidade real no volume atual. Consultas filtradas continuam direto em
-- `calls`, como antes desta migração.
--
-- Reprocessamento idempotente (plano item 2): a função sempre RECALCULA o
-- dia inteiro a partir de `calls` e faz UPSERT — nunca soma incrementos.
-- Chamar a função duas vezes para o mesmo dia produz o mesmo resultado,
-- então tanto o gatilho quanto o reprocessamento manual (endpoint de
-- correção) podem rodar quantas vezes forem necessárias sem risco de
-- duplicar contagem.
CREATE TABLE IF NOT EXISTS metrics_daily_rollup (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  day DATE NOT NULL,
  calls_made INTEGER NOT NULL DEFAULT 0,
  calls_answered INTEGER NOT NULL DEFAULT 0,
  unique_leads_worked INTEGER NOT NULL DEFAULT 0,
  positive_results INTEGER NOT NULL DEFAULT 0,
  connected_seconds INTEGER NOT NULL DEFAULT 0,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, day)
);

-- Códigos "positivos" replicados de POSITIVE_CALL_RESULT_CODES em
-- metrics.definitions.ts (classification IN ('positive', 'conversion')) —
-- mesma duplicação SQL/TS já aceita neste projeto para o catálogo padrão
-- (ver 015_metrics_catalogs.sql). Se esses códigos mudarem no TS, esta
-- lista precisa ser atualizada junto.
CREATE OR REPLACE FUNCTION refresh_metrics_daily_rollup(p_tenant_id TEXT, p_day DATE) RETURNS void AS $$
DECLARE
  v_timezone TEXT;
BEGIN
  SELECT timezone INTO v_timezone FROM tenants WHERE id = p_tenant_id;
  IF v_timezone IS NULL THEN v_timezone := 'America/Sao_Paulo'; END IF;

  INSERT INTO metrics_daily_rollup (tenant_id, day, calls_made, calls_answered, unique_leads_worked, positive_results, connected_seconds, computed_at)
  SELECT
    p_tenant_id,
    p_day,
    count(*)::int,
    count(*) FILTER (WHERE connected_at IS NOT NULL)::int,
    count(DISTINCT lead_id)::int,
    count(*) FILTER (WHERE call_result = ANY(ARRAY['reuniao_agendada', 'interessado']))::int,
    COALESCE(sum(connected_duration_seconds) FILTER (WHERE connected_at IS NOT NULL), 0)::int,
    now()
  FROM calls
  WHERE tenant_id = p_tenant_id
    AND created_at >= (p_day::timestamp AT TIME ZONE v_timezone)
    AND created_at < ((p_day + 1)::timestamp AT TIME ZONE v_timezone)
  ON CONFLICT (tenant_id, day) DO UPDATE SET
    calls_made = EXCLUDED.calls_made,
    calls_answered = EXCLUDED.calls_answered,
    unique_leads_worked = EXCLUDED.unique_leads_worked,
    positive_results = EXCLUDED.positive_results,
    connected_seconds = EXCLUDED.connected_seconds,
    computed_at = EXCLUDED.computed_at;
END;
$$ LANGUAGE plpgsql;

-- Backfill: popula o rollup para todo (tenant, dia) que já tem chamadas,
-- para que a otimização valha imediatamente para dados existentes, não só
-- para chamadas futuras.
DO $$
DECLARE
  pair RECORD;
BEGIN
  FOR pair IN
    SELECT DISTINCT c.tenant_id, (c.created_at AT TIME ZONE COALESCE(t.timezone, 'America/Sao_Paulo'))::date AS day
    FROM calls c JOIN tenants t ON t.id = c.tenant_id
  LOOP
    PERFORM refresh_metrics_daily_rollup(pair.tenant_id, pair.day);
  END LOOP;
END $$;

-- Gatilho: mantém o dia em dia a cada escrita relevante em `calls`. Uma
-- chamada só pertence a um dia civil (definido por created_at), então
-- recalcular o dia de NEW é sempre suficiente — não há necessidade de olhar
-- OLD. Dispara em INSERT (chamada nova já conta em "chamadas realizadas")
-- e nas colunas que podem mudar depois (conexão, resultado, etapa,
-- pós-atendimento, duração conectada).
CREATE OR REPLACE FUNCTION metrics_daily_rollup_trigger_fn() RETURNS TRIGGER AS $$
DECLARE
  v_timezone TEXT;
  v_day DATE;
BEGIN
  SELECT timezone INTO v_timezone FROM tenants WHERE id = NEW.tenant_id;
  IF v_timezone IS NULL THEN v_timezone := 'America/Sao_Paulo'; END IF;
  v_day := (NEW.created_at AT TIME ZONE v_timezone)::date;
  PERFORM refresh_metrics_daily_rollup(NEW.tenant_id, v_day);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS calls_refresh_daily_rollup_trg ON calls;
CREATE TRIGGER calls_refresh_daily_rollup_trg
AFTER INSERT OR UPDATE OF status, connected_at, ended_at, call_result, pipeline_stage, wrap_up_completed_at, connected_duration_seconds ON calls
FOR EACH ROW EXECUTE FUNCTION metrics_daily_rollup_trigger_fn();
