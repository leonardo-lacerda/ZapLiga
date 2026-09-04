-- Rollout gates for the defensible-product roadmap. Every capability starts
-- disabled so this expansion is compatible with the application version that
-- predates these columns.
ALTER TABLE tenant_feature_flags ADD COLUMN IF NOT EXISTS campaigns boolean NOT NULL DEFAULT false;
ALTER TABLE tenant_feature_flags ADD COLUMN IF NOT EXISTS decision_engine boolean NOT NULL DEFAULT false;
ALTER TABLE tenant_feature_flags ADD COLUMN IF NOT EXISTS recommendations boolean NOT NULL DEFAULT false;
ALTER TABLE tenant_feature_flags ADD COLUMN IF NOT EXISTS operation_health boolean NOT NULL DEFAULT false;
ALTER TABLE tenant_feature_flags ADD COLUMN IF NOT EXISTS analytics_learning boolean NOT NULL DEFAULT false;
ALTER TABLE tenant_feature_flags ADD COLUMN IF NOT EXISTS experiments boolean NOT NULL DEFAULT false;
ALTER TABLE tenant_feature_flags ADD COLUMN IF NOT EXISTS benchmarks boolean NOT NULL DEFAULT false;
