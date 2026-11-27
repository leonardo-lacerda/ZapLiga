-- The device profile each line presents in the WhatsApp handshake, frozen once
-- (docs/device-profile.md). A line registered on a GeeLark cloud phone keeps the
-- phone's identity: the profile is written when the number is linked to that
-- phone and is never rewritten, so every reconnection of the same line presents
-- the same device. Changing it requires re-pairing, which the panel says out loud.
--
-- geelark_phone_id: the cloud phone the line was registered on. One phone hosts
-- one line, so the partial unique index keeps a phone from carrying two.
--
-- device_profile: the frozen JSON (see docs/device-profile.md for the shape).
-- NULL means the line predates this and keeps using the Waxum environment
-- defaults, which is exactly today's behaviour.
--
-- device_profile_frozen_at: when it was written. A profile is never regenerated;
-- a line that needs a different one is re-paired.
ALTER TABLE whatsapp_numbers
  ADD COLUMN IF NOT EXISTS geelark_phone_id TEXT,
  ADD COLUMN IF NOT EXISTS device_profile JSONB,
  ADD COLUMN IF NOT EXISTS device_profile_frozen_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_numbers_geelark_phone_idx
  ON whatsapp_numbers (geelark_phone_id)
  WHERE geelark_phone_id IS NOT NULL;
