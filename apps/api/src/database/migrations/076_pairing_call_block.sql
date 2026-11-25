-- Lines created from now on stay out of the dialer for 24 h after each pairing QR or code,
-- because WhatsApp removes a device that calls minutes after being linked. Lines that
-- already exist keep the default (false) and pair as before.
ALTER TABLE whatsapp_numbers ADD COLUMN IF NOT EXISTS block_calls_after_pairing BOOLEAN NOT NULL DEFAULT false;
