-- Fase 6 do plano de métricas: metas por organização, SDR ou pasta (plano
-- seção 6.7). Metas nunca são alteradas em UPDATE — editar congela a linha
-- atual (status='frozen') e insere uma nova linha ativa, preservando o valor
-- que estava vigente em cada período para relatórios históricos (plano:
-- "metas antigas devem permanecer congeladas para preservar relatórios
-- históricos"). Excluir também não apaga: arquiva (status='archived').

CREATE TABLE IF NOT EXISTS metric_goals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope TEXT NOT NULL CHECK (scope IN ('organization', 'sdr', 'folder')),
  -- NULL quando scope = 'organization'; sdr_id ou folder_id nos demais casos.
  -- Sem FK direta (referência polimórfica) — validado na camada de aplicação.
  scope_id TEXT,
  metric TEXT NOT NULL CHECK (metric IN ('calls_made', 'leads_worked', 'answer_rate', 'positive_results', 'stage_advances', 'conversions', 'connected_seconds')),
  value_type TEXT NOT NULL CHECK (value_type IN ('absolute', 'percentage')),
  target_value NUMERIC NOT NULL CHECK (target_value >= 0),
  period_from DATE NOT NULL,
  period_to DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'archived')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  frozen_at TIMESTAMPTZ,
  superseded_by TEXT REFERENCES metric_goals(id),
  CHECK (period_to >= period_from),
  CHECK ((scope = 'organization') = (scope_id IS NULL))
);

-- No máximo uma meta ativa por combinação tenant+escopo+métrica de cada vez
-- (COALESCE normaliza scope_id NULL, senão índices únicos tratam cada NULL
-- como distinto e a organização poderia acumular metas ativas duplicadas).
CREATE UNIQUE INDEX IF NOT EXISTS metric_goals_active_unique
  ON metric_goals (tenant_id, scope, COALESCE(scope_id, ''), metric)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS metric_goals_tenant_status_idx ON metric_goals (tenant_id, status);
CREATE INDEX IF NOT EXISTS metric_goals_tenant_scope_idx ON metric_goals (tenant_id, scope, scope_id);
