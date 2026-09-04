-- Drafts, optimistic concurrency and immutable published campaign versions.
-- Existing legacy campaigns keep version 1; newly-created drafts start without
-- a published version until the explicit publish transition.

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS draft_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS lock_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_by TEXT REFERENCES users(id) ON DELETE SET NULL;

UPDATE campaigns c
SET draft_config = cv.config_snapshot,
    published_at = COALESCE(c.published_at, cv.created_at)
FROM campaign_versions cv
WHERE cv.tenant_id = c.tenant_id
  AND cv.campaign_id = c.id
  AND cv.version = c.current_version
  AND c.draft_config = '{}'::jsonb;

ALTER TABLE campaigns ALTER COLUMN current_version DROP DEFAULT;
ALTER TABLE campaigns ALTER COLUMN current_version DROP NOT NULL;
ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_current_version_check;
ALTER TABLE campaigns ADD CONSTRAINT campaigns_current_version_check
  CHECK (current_version IS NULL OR current_version > 0);
ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_draft_config_object_check;
ALTER TABLE campaigns ADD CONSTRAINT campaigns_draft_config_object_check
  CHECK (jsonb_typeof(draft_config) = 'object');
ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_lock_version_check;
ALTER TABLE campaigns ADD CONSTRAINT campaigns_lock_version_check
  CHECK (lock_version >= 0);

ALTER TABLE campaign_versions
  ADD COLUMN IF NOT EXISTS published_from_lock_version INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION prevent_campaign_version_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'campaign_versions are immutable'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS campaign_versions_immutable_update_trg ON campaign_versions;
CREATE TRIGGER campaign_versions_immutable_update_trg
BEFORE UPDATE ON campaign_versions
FOR EACH ROW EXECUTE FUNCTION prevent_campaign_version_update();

CREATE INDEX IF NOT EXISTS campaigns_tenant_lock_version_idx
  ON campaigns (tenant_id, id, lock_version);
