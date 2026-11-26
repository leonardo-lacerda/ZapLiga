-- Camouflage per line (docs/stealth-profile.md), an experiment: off for every existing line.
-- - stealth_enabled: the line asks its Waxum for its own identity (browser registration props and
--   pt-BR login) instead of the container's.
-- - stealth_profile: that identity, generated the first time the switch goes on and frozen; turning
--   it on again reuses it.
-- - stealth_profile_frozen_at: when it was frozen. A line paired after it is fully covered; one
--   paired before only has the login part until a new QR or code.
ALTER TABLE whatsapp_numbers
  ADD COLUMN IF NOT EXISTS stealth_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stealth_profile JSONB,
  ADD COLUMN IF NOT EXISTS stealth_profile_frozen_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS whatsapp_numbers_stealth_idx ON whatsapp_numbers (tenant_id) WHERE stealth_enabled;
