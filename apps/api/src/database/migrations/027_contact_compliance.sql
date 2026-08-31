-- Canonical, tenant-scoped contact suppression registry. Unlike leads.do_not_call,
-- these records survive lead deletion and re-imports.

CREATE TABLE IF NOT EXISTS contact_suppressions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone TEXT NOT NULL CHECK (phone ~ '^[0-9]{10,15}$'),
  reason TEXT NOT NULL CHECK (reason IN ('requested_opt_out', 'invalid_number', 'legal_restriction', 'internal_policy', 'other')),
  source TEXT NOT NULL CHECK (source IN ('post_call', 'lead_action', 'import', 'admin', 'api', 'migration')),
  notes TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lifted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  lifted_at TIMESTAMPTZ,
  lift_reason TEXT,
  CHECK ((lifted_at IS NULL AND lifted_by IS NULL AND lift_reason IS NULL) OR lifted_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS contact_suppressions_active_phone_idx
  ON contact_suppressions (tenant_id, phone) WHERE lifted_at IS NULL;
CREATE INDEX IF NOT EXISTS contact_suppressions_tenant_created_idx
  ON contact_suppressions (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS contact_compliance_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone TEXT NOT NULL CHECK (phone ~ '^[0-9]{10,15}$'),
  event_type TEXT NOT NULL CHECK (event_type IN ('consent_recorded', 'opt_out_recorded', 'suppression_lifted', 'data_corrected')),
  source TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contact_compliance_events_tenant_phone_idx
  ON contact_compliance_events (tenant_id, phone, created_at DESC);

INSERT INTO contact_suppressions (id, tenant_id, phone, reason, source, notes, created_at)
SELECT gen_random_uuid()::text, l.tenant_id, l.phone, 'internal_policy', 'migration',
       'Migrado do campo legado leads.do_not_call', now()
FROM leads l
WHERE l.do_not_call = true
ON CONFLICT DO NOTHING;

INSERT INTO contact_compliance_events (id, tenant_id, phone, event_type, source, evidence)
SELECT gen_random_uuid()::text, s.tenant_id, s.phone, 'opt_out_recorded', 'migration',
       jsonb_build_object('suppressionId', s.id, 'reason', s.reason)
FROM contact_suppressions s
WHERE s.source = 'migration'
  AND NOT EXISTS (
    SELECT 1 FROM contact_compliance_events e
    WHERE e.tenant_id = s.tenant_id AND e.phone = s.phone AND e.source = 'migration'
  );

INSERT INTO call_result_catalog (tenant_id, id, label, classification, sort_order)
SELECT id, 'nao_ligar_novamente', 'Não ligar novamente', 'negative', 5 FROM tenants
ON CONFLICT (tenant_id, id) DO NOTHING;

CREATE OR REPLACE FUNCTION seed_default_metrics_catalog(target_tenant_id TEXT) RETURNS void AS $$
BEGIN
  INSERT INTO call_result_catalog (tenant_id, id, label, classification, sort_order) VALUES
    (target_tenant_id, 'reuniao_agendada', 'Reunião agendada', 'conversion', 0),
    (target_tenant_id, 'interessado', 'Interessado', 'positive', 1),
    (target_tenant_id, 'retornar', 'Solicitou retorno', 'neutral', 2),
    (target_tenant_id, 'sem_interesse', 'Sem interesse', 'negative', 3),
    (target_tenant_id, 'numero_invalido', 'Número inválido', 'negative', 4),
    (target_tenant_id, 'nao_ligar_novamente', 'Não ligar novamente', 'negative', 5)
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

