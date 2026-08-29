-- Fase 7 do plano de métricas: exportações (com processamento assíncrono
-- para conjuntos grandes — plano seção 13) e visualizações salvas (plano
-- seção 6.8).

CREATE TABLE IF NOT EXISTS metric_exports (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  requested_by TEXT NOT NULL REFERENCES users(id),
  dataset TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('csv', 'pdf')),
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_count INTEGER,
  file_name TEXT,
  content_type TEXT,
  -- Guardado no próprio Postgres em vez de disco/S3 — não há infraestrutura
  -- de armazenamento de arquivos no projeto ainda, e exportações de métricas
  -- são tipicamente KB a poucos MB, o que o BYTEA acomoda sem problema.
  file_data BYTEA,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS metric_exports_tenant_created_idx ON metric_exports (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS metric_saved_views (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  filters JSONB NOT NULL,
  is_shared BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS metric_saved_views_owner_name_unique ON metric_saved_views (tenant_id, owner_user_id, lower(name));
CREATE INDEX IF NOT EXISTS metric_saved_views_tenant_idx ON metric_saved_views (tenant_id, is_shared);
