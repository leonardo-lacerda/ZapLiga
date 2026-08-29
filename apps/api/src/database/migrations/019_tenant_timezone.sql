-- Fase 2 do plano de métricas: timezone por tenant (plano seção 8.2, item 10).
-- Fase 1 já documentava a regra ("períodos respeitam o timezone da
-- organização") usando um padrão fixo no código; agora cada tenant pode ter
-- o seu, mas todo tenant existente mantém o mesmo padrão de hoje.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo';
