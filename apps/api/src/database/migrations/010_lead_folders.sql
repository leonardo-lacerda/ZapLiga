-- Lead folders/lists. Existing leads are kept in an active default folder.
CREATE TABLE IF NOT EXISTS lead_folders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deactivated_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS lead_folders_tenant_name_unique
  ON lead_folders (tenant_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS lead_folders_tenant_id_unique
  ON lead_folders (tenant_id, id);

ALTER TABLE leads ADD COLUMN IF NOT EXISTS folder_id TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS folder_id TEXT;
ALTER TABLE dialer_settings ADD COLUMN IF NOT EXISTS folder_rotation_cursor INTEGER NOT NULL DEFAULT 0;

DO $$
DECLARE
  tenant_row RECORD;
  default_folder_id TEXT;
BEGIN
  FOR tenant_row IN SELECT id FROM tenants LOOP
    default_folder_id := 'folder-default-' || tenant_row.id;
    INSERT INTO lead_folders (id, tenant_id, name, is_active, sort_order)
    VALUES (default_folder_id, tenant_row.id, 'Lista principal', true, 0)
    ON CONFLICT (id) DO NOTHING;

    UPDATE leads
       SET folder_id = default_folder_id
     WHERE tenant_id = tenant_row.id AND folder_id IS NULL;

    UPDATE calls c
       SET folder_id = l.folder_id
      FROM leads l
     WHERE c.tenant_id = tenant_row.id
       AND c.lead_id = l.id
       AND c.folder_id IS NULL;

    UPDATE calls
       SET folder_id = default_folder_id
     WHERE tenant_id = tenant_row.id AND folder_id IS NULL;
  END LOOP;
END $$;

ALTER TABLE leads ALTER COLUMN folder_id SET NOT NULL;
ALTER TABLE calls ALTER COLUMN folder_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_tenant_folder_fk') THEN
    ALTER TABLE leads
      ADD CONSTRAINT leads_tenant_folder_fk
      FOREIGN KEY (tenant_id, folder_id)
      REFERENCES lead_folders (tenant_id, id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calls_tenant_folder_fk') THEN
    ALTER TABLE calls
      ADD CONSTRAINT calls_tenant_folder_fk
      FOREIGN KEY (tenant_id, folder_id)
      REFERENCES lead_folders (tenant_id, id) NOT VALID;
  END IF;
END $$;

ALTER TABLE leads VALIDATE CONSTRAINT leads_tenant_folder_fk;
ALTER TABLE calls VALIDATE CONSTRAINT calls_tenant_folder_fk;

CREATE INDEX IF NOT EXISTS leads_tenant_folder_idx
  ON leads (tenant_id, folder_id);
CREATE INDEX IF NOT EXISTS leads_tenant_folder_queue_idx
  ON leads (tenant_id, folder_id, status, next_eligible_at)
  WHERE do_not_call = false;
CREATE INDEX IF NOT EXISTS leads_tenant_folder_created_idx
  ON leads (tenant_id, folder_id, created_at DESC);
CREATE INDEX IF NOT EXISTS calls_tenant_folder_created_idx
  ON calls (tenant_id, folder_id, created_at DESC);
