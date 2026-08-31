CREATE TABLE IF NOT EXISTS tenant_feature_flags (
  tenant_id text PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  schedule_enforcement boolean NOT NULL DEFAULT false,
  callbacks boolean NOT NULL DEFAULT false,
  privacy_requests boolean NOT NULL DEFAULT false,
  onboarding boolean NOT NULL DEFAULT false,
  updated_by text REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO tenant_feature_flags (tenant_id) SELECT id FROM tenants ON CONFLICT (tenant_id) DO NOTHING;

CREATE OR REPLACE FUNCTION create_default_tenant_feature_flags() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO tenant_feature_flags (tenant_id) VALUES (NEW.id) ON CONFLICT (tenant_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenants_default_feature_flags ON tenants;
CREATE TRIGGER tenants_default_feature_flags AFTER INSERT ON tenants FOR EACH ROW EXECUTE FUNCTION create_default_tenant_feature_flags();

-- Older installations only backfilled folders. Public registration also needs
-- a default folder for every tenant created after that migration.
CREATE OR REPLACE FUNCTION create_default_lead_folder() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO lead_folders (id, tenant_id, name, is_active, sort_order)
  VALUES ('folder-default-' || NEW.id, NEW.id, 'Lista principal', true, 0)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenants_default_lead_folder ON tenants;
CREATE TRIGGER tenants_default_lead_folder AFTER INSERT ON tenants FOR EACH ROW EXECUTE FUNCTION create_default_lead_folder();

INSERT INTO lead_folders (id, tenant_id, name, is_active, sort_order)
SELECT 'folder-default-' || t.id, t.id, 'Lista principal', true, 0
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM lead_folders f WHERE f.tenant_id = t.id)
ON CONFLICT DO NOTHING;
