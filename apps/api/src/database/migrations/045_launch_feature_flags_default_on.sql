-- Launch features are available by default. Super admins can still disable
-- them per tenant for incident rollback without deleting data.
ALTER TABLE tenant_feature_flags
  ALTER COLUMN schedule_enforcement SET DEFAULT true,
  ALTER COLUMN callbacks SET DEFAULT true,
  ALTER COLUMN privacy_requests SET DEFAULT true,
  ALTER COLUMN onboarding SET DEFAULT true;

UPDATE tenant_feature_flags
SET
  schedule_enforcement = true,
  callbacks = true,
  privacy_requests = true,
  onboarding = true,
  updated_at = now()
WHERE schedule_enforcement IS DISTINCT FROM true
   OR callbacks IS DISTINCT FROM true
   OR privacy_requests IS DISTINCT FROM true
   OR onboarding IS DISTINCT FROM true;

CREATE OR REPLACE FUNCTION create_default_tenant_feature_flags() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO tenant_feature_flags (
    tenant_id,
    schedule_enforcement,
    callbacks,
    privacy_requests,
    onboarding
  ) VALUES (
    NEW.id,
    true,
    true,
    true,
    true
  ) ON CONFLICT (tenant_id) DO NOTHING;
  RETURN NEW;
END;
$$;
