-- WhatsApp flags accounts that reach out to non-contacts too aggressively
-- (463 MissingTcToken / reachout timelock). When we detect that on a line, we
-- quarantine it until this timestamp so the dialer routes to healthy lines and
-- stops burning the flagged account (which only deepens the penalty).
ALTER TABLE whatsapp_numbers ADD COLUMN IF NOT EXISTS flagged_until TIMESTAMPTZ;
