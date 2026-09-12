-- Number ownership and dialer concurrency are no longer commercial plan limits.
-- Keep the existing migration history immutable and clean old snapshots in place.
UPDATE billing_plan_versions
SET limit_entitlements = COALESCE(limit_entitlements, '{}'::jsonb) - 'numbers' - 'max_concurrent_dialers',
    updated_at = now()
WHERE limit_entitlements ?| ARRAY['numbers', 'max_concurrent_dialers'];

UPDATE tenant_entitlements
SET limit_entitlements = COALESCE(limit_entitlements, '{}'::jsonb) - 'numbers' - 'max_concurrent_dialers',
    updated_at = now()
WHERE limit_entitlements ?| ARRAY['numbers', 'max_concurrent_dialers'];
