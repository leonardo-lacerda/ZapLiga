-- Versão do WhatsApp instalado no phone em cada cadastro: separa as falhas por versão do app
-- (uma tela nova do WhatsApp costuma chegar junto com uma versão nova).
ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS app_version TEXT;
CREATE INDEX IF NOT EXISTS provisioning_jobs_stats_idx ON provisioning_jobs (tenant_id, created_at) WHERE finished_at IS NOT NULL;
