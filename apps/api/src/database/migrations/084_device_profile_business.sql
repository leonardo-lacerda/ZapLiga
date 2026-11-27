-- New camouflage per line (docs/device-profile.md): the frozen profile now says whether the account
-- is WhatsApp Business, because a Business account only links a second phone that says Business.
-- Profiles frozen before this keep what they did (regular WhatsApp); the admin changes the app on
-- the line card, and it takes effect at the line's next pairing.
UPDATE whatsapp_numbers
SET device_profile = jsonb_set(device_profile, '{android,business}', 'false'::jsonb)
WHERE device_profile IS NOT NULL AND NOT (device_profile->'android' ? 'business');
