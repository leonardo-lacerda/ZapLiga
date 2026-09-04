-- Campaign read model. This is an additive migration: legacy dialer tables and
-- behavior remain untouched while the campaigns feature flag is disabled.

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'ready', 'running', 'paused', 'completed', 'archived')),
  folder_id TEXT,
  primary_goal_metric TEXT,
  primary_goal_target NUMERIC,
  current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version > 0),
  is_legacy BOOLEAN NOT NULL DEFAULT false,
  started_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT campaigns_folder_required_unless_legacy CHECK (is_legacy OR folder_id IS NOT NULL),
  CONSTRAINT campaigns_tenant_folder_fk
    FOREIGN KEY (tenant_id, folder_id) REFERENCES lead_folders(tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS campaigns_tenant_name_unique
  ON campaigns (tenant_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS campaigns_one_legacy_per_tenant_idx
  ON campaigns (tenant_id) WHERE is_legacy = true;
CREATE INDEX IF NOT EXISTS campaigns_tenant_status_updated_idx
  ON campaigns (tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS campaigns_tenant_folder_idx
  ON campaigns (tenant_id, folder_id) WHERE folder_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS campaign_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  config_snapshot JSONB NOT NULL,
  config_hash TEXT NOT NULL,
  change_reason TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, campaign_id, version),
  CONSTRAINT campaign_versions_tenant_campaign_fk
    FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS campaign_versions_tenant_created_idx
  ON campaign_versions (tenant_id, campaign_id, created_at DESC);

CREATE TABLE IF NOT EXISTS campaign_sdrs (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL,
  sdr_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, campaign_id, sdr_id),
  CONSTRAINT campaign_sdrs_tenant_campaign_fk
    FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT campaign_sdrs_tenant_sdr_fk
    FOREIGN KEY (tenant_id, sdr_id) REFERENCES sdrs(tenant_id, id) ON DELETE CASCADE
);

-- Migration 009 removed this composite key while numbers were temporarily
-- global. Numbers are tenant-owned again since migration 013, and campaign
-- links require the database to validate tenant ownership atomically.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_numbers_tenant_id_unique
  ON whatsapp_numbers (tenant_id, id);

CREATE TABLE IF NOT EXISTS campaign_numbers (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL,
  number_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, campaign_id, number_id),
  CONSTRAINT campaign_numbers_tenant_campaign_fk
    FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT campaign_numbers_tenant_number_fk
    FOREIGN KEY (tenant_id, number_id) REFERENCES whatsapp_numbers(tenant_id, id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION seed_legacy_campaign(target_tenant_id TEXT) RETURNS void AS $$
DECLARE
  legacy_campaign_id TEXT := 'campaign-legacy-' || target_tenant_id;
  legacy_snapshot JSONB;
  legacy_status TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = target_tenant_id) THEN
    RETURN;
  END IF;

  SELECT CASE WHEN COALESCE(ds.running, false) THEN 'running' ELSE 'ready' END
    INTO legacy_status
  FROM tenants t
  LEFT JOIN dialer_settings ds ON ds.tenant_id = t.id
  WHERE t.id = target_tenant_id;

  SELECT jsonb_build_object(
    'schema_version', 1,
    'source', 'legacy_operation',
    'uses_all_active_folders', true,
    'timezone', (SELECT t.timezone FROM tenants t WHERE t.id = target_tenant_id),
    'folder_ids', COALESCE((
      SELECT jsonb_agg(f.id ORDER BY f.sort_order, f.created_at, f.id)
      FROM lead_folders f
      WHERE f.tenant_id = target_tenant_id AND f.is_active = true
    ), '[]'::jsonb),
    'sdr_ids', COALESCE((
      SELECT jsonb_agg(s.id ORDER BY s.created_at, s.id)
      FROM sdrs s
      WHERE s.tenant_id = target_tenant_id
    ), '[]'::jsonb),
    'number_ids', COALESCE((
      SELECT jsonb_agg(n.id ORDER BY n.created_at, n.id)
      FROM whatsapp_numbers n
      WHERE n.tenant_id = target_tenant_id AND n.status <> 'removed'
    ), '[]'::jsonb),
    'dialer_settings', COALESCE((
      SELECT to_jsonb(ds) - 'tenant_id'
      FROM dialer_settings ds
      WHERE ds.tenant_id = target_tenant_id
    ), '{}'::jsonb),
    'schedule_windows', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object('day_of_week', w.day_of_week, 'start_time', w.start_time, 'end_time', w.end_time)
        ORDER BY w.day_of_week, w.start_time, w.end_time
      )
      FROM dialer_schedule_windows w
      WHERE w.tenant_id = target_tenant_id
    ), '[]'::jsonb),
    'schedule_exceptions', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object('local_date', e.local_date, 'is_closed', e.is_closed, 'start_time', e.start_time, 'end_time', e.end_time, 'reason', e.reason)
        ORDER BY e.local_date
      )
      FROM dialer_schedule_exceptions e
      WHERE e.tenant_id = target_tenant_id
    ), '[]'::jsonb)
  ) INTO legacy_snapshot;

  INSERT INTO campaigns (
    id, tenant_id, name, description, status, current_version, is_legacy, started_at
  ) VALUES (
    legacy_campaign_id,
    target_tenant_id,
    'Operação legada',
    'Representação somente leitura da operação anterior ao domínio de campanhas.',
    COALESCE(legacy_status, 'ready'),
    1,
    true,
    CASE WHEN legacy_status = 'running' THEN now() ELSE NULL END
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO campaign_versions (
    id, tenant_id, campaign_id, version, config_snapshot, config_hash, change_reason
  )
  SELECT
    'campaign-version-legacy-' || target_tenant_id,
    target_tenant_id,
    legacy_campaign_id,
    1,
    legacy_snapshot,
    md5(legacy_snapshot::text),
    'Backfill automático da configuração legada'
  WHERE EXISTS (
    SELECT 1 FROM campaigns c
    WHERE c.tenant_id = target_tenant_id AND c.id = legacy_campaign_id
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO campaign_sdrs (tenant_id, campaign_id, sdr_id)
  SELECT target_tenant_id, legacy_campaign_id, s.id
  FROM sdrs s
  WHERE s.tenant_id = target_tenant_id
  ON CONFLICT DO NOTHING;

  INSERT INTO campaign_numbers (tenant_id, campaign_id, number_id)
  SELECT target_tenant_id, legacy_campaign_id, n.id
  FROM whatsapp_numbers n
  WHERE n.tenant_id = target_tenant_id AND n.status <> 'removed'
  ON CONFLICT DO NOTHING;
END;
$$ LANGUAGE plpgsql;

SELECT seed_legacy_campaign(id) FROM tenants ORDER BY id;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campaigns_current_version_fk') THEN
    ALTER TABLE campaigns
      ADD CONSTRAINT campaigns_current_version_fk
      FOREIGN KEY (tenant_id, id, current_version)
      REFERENCES campaign_versions(tenant_id, campaign_id, version)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION seed_legacy_campaign_for_new_tenant() RETURNS trigger AS $$
BEGIN
  PERFORM seed_legacy_campaign(NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tenants_seed_legacy_campaign_trg ON tenants;
CREATE TRIGGER tenants_seed_legacy_campaign_trg
AFTER INSERT ON tenants
FOR EACH ROW EXECUTE FUNCTION seed_legacy_campaign_for_new_tenant();

-- Keep the compatibility campaign representative as resources are connected
-- after tenant creation. These triggers only maintain the new read model and
-- never participate in dialer selection.
CREATE OR REPLACE FUNCTION attach_sdr_to_legacy_campaign() RETURNS trigger AS $$
BEGIN
  INSERT INTO campaign_sdrs (tenant_id, campaign_id, sdr_id)
  SELECT NEW.tenant_id, c.id, NEW.id
  FROM campaigns c
  WHERE c.tenant_id = NEW.tenant_id AND c.is_legacy = true
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sdrs_attach_legacy_campaign_trg ON sdrs;
CREATE TRIGGER sdrs_attach_legacy_campaign_trg
AFTER INSERT ON sdrs
FOR EACH ROW EXECUTE FUNCTION attach_sdr_to_legacy_campaign();

CREATE OR REPLACE FUNCTION sync_number_with_legacy_campaign() RETURNS trigger AS $$
BEGIN
  DELETE FROM campaign_numbers cn
  WHERE cn.number_id = NEW.id
    AND (cn.tenant_id IS DISTINCT FROM NEW.tenant_id OR NEW.status = 'removed');

  IF NEW.tenant_id IS NOT NULL AND NEW.status <> 'removed' THEN
    INSERT INTO campaign_numbers (tenant_id, campaign_id, number_id)
    SELECT NEW.tenant_id, c.id, NEW.id
    FROM campaigns c
    WHERE c.tenant_id = NEW.tenant_id AND c.is_legacy = true
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS whatsapp_numbers_sync_legacy_campaign_trg ON whatsapp_numbers;
CREATE TRIGGER whatsapp_numbers_sync_legacy_campaign_trg
AFTER INSERT OR UPDATE OF tenant_id, status ON whatsapp_numbers
FOR EACH ROW EXECUTE FUNCTION sync_number_with_legacy_campaign();
