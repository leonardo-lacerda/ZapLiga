-- Fase 2 do plano de métricas: índices compostos para os filtros que a área
-- de métricas usa (plano seção 8.2, item 13) — tenant + data já existe
-- (calls_tenant_created_idx); aqui somam-se SDR, número, status, origem e
-- resultado/etapa, cada um combinado com tenant (nunca sem tenant).

CREATE INDEX IF NOT EXISTS calls_tenant_sdr_created_idx ON calls (tenant_id, sdr_id, created_at DESC);
CREATE INDEX IF NOT EXISTS calls_tenant_number_created_idx ON calls (tenant_id, number_id, created_at DESC);
CREATE INDEX IF NOT EXISTS calls_tenant_status_created_idx ON calls (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS calls_tenant_source_created_idx ON calls (tenant_id, source, created_at DESC);
CREATE INDEX IF NOT EXISTS calls_tenant_call_result_idx ON calls (tenant_id, call_result) WHERE call_result IS NOT NULL;
CREATE INDEX IF NOT EXISTS calls_tenant_pipeline_stage_idx ON calls (tenant_id, pipeline_stage) WHERE pipeline_stage IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_tenant_pipeline_stage_idx ON leads (tenant_id, pipeline_stage);
