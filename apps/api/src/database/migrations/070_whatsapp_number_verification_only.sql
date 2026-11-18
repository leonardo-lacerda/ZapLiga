-- A line can be set aside only for checking whether a phone has WhatsApp
-- (POST /api/v1/integrations/whatsapp-check). Such a line never places calls.
ALTER TABLE whatsapp_numbers ADD COLUMN IF NOT EXISTS verification_only BOOLEAN NOT NULL DEFAULT false;
