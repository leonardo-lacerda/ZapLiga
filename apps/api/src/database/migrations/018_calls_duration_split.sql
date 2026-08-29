-- Fase 2 do plano de métricas: separa duração de toque e duração conectada
-- (plano seção 8.2, item 11). `calls.duration_seconds` continua existindo
-- sem mudar de sentido (código e frontend existentes dependem dela) — estas
-- colunas são aditivas.
--
-- Ambas são derivadas de timestamps que já existem em toda chamada
-- encerrada (`started_at`, `connected_at`, `ended_at`), então o backfill é
-- exato, não uma estimativa.

ALTER TABLE calls ADD COLUMN IF NOT EXISTS ring_duration_seconds INTEGER;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS connected_duration_seconds INTEGER;

UPDATE calls SET
  ring_duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(connected_at, ended_at) - started_at))::int)
WHERE ring_duration_seconds IS NULL AND started_at IS NOT NULL;

UPDATE calls SET
  connected_duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (ended_at - connected_at))::int)
WHERE connected_duration_seconds IS NULL AND connected_at IS NOT NULL AND ended_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS calls_tenant_connected_duration_idx ON calls (tenant_id, connected_duration_seconds) WHERE connected_at IS NOT NULL;
