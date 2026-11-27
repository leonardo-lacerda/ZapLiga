-- New camouflage per line (docs/device-profile.md): the line logs in as the Android phone it was
-- registered on, a Multilogin cloud phone. Opt-in per line, off for every existing line, and it
-- only takes effect when the line pairs (QR or code): until then the line runs exactly as today.
-- - device_profile_enabled: what the admin chose for the line.
-- - device_profile_active: what the line's current pairing carries. Set at each pairing request
--   to the choice of that moment; reconnects send what the line paired with.
-- - multilogin_phone_id: the cloud phone the profile was copied from. A phone gives its identity
--   to one line only, ever: two accounts with the same phone would be tied together.
-- - device_profile: the frozen profile (brand, model, Android, carrier, phone_id).
-- - device_profile_frozen_at: when it was copied.
ALTER TABLE whatsapp_numbers
  ADD COLUMN IF NOT EXISTS device_profile_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS device_profile_active BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS multilogin_phone_id TEXT,
  ADD COLUMN IF NOT EXISTS device_profile JSONB,
  ADD COLUMN IF NOT EXISTS device_profile_frozen_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_numbers_multilogin_phone_idx
  ON whatsapp_numbers (multilogin_phone_id)
  WHERE multilogin_phone_id IS NOT NULL;
