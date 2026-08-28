-- Every tenant must have an independent dialer configuration.
-- Backfill tenants created before the per-tenant settings flow existed.
INSERT INTO dialer_settings (tenant_id)
SELECT t.id
FROM tenants t
LEFT JOIN dialer_settings ds ON ds.tenant_id = t.id
WHERE ds.tenant_id IS NULL
ON CONFLICT (tenant_id) DO NOTHING;

-- Keep the invariant at database level so every tenant creation path is covered.
CREATE OR REPLACE FUNCTION ensure_tenant_dialer_settings()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO dialer_settings (tenant_id)
  VALUES (NEW.id)
  ON CONFLICT (tenant_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenants_create_dialer_settings ON tenants;

CREATE TRIGGER tenants_create_dialer_settings
AFTER INSERT ON tenants
FOR EACH ROW
EXECUTE FUNCTION ensure_tenant_dialer_settings();
