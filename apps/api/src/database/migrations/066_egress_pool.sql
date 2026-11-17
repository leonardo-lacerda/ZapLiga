-- Egress pool (docs/saida-pelo-pc-do-atendente.md): PCs register themselves when
-- they join Tailscale with the shared install command, and the API spreads the
-- lines across the PCs that are online.

-- A PC that joined while every slot was taken waits without one.
ALTER TABLE egress_pcs ALTER COLUMN slot DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS egress_pcs_device_idx ON egress_pcs (tailscale_device_id);
-- Since when the slot has not been going out through its PC; the pool moves the
-- lines away after offline_grace_seconds.
ALTER TABLE egress_pcs ADD COLUMN IF NOT EXISTS offline_since TIMESTAMPTZ;

-- The reusable join key behind the install command (encryptSecret()).
ALTER TABLE egress_settings ADD COLUMN IF NOT EXISTS pc_auth_key TEXT;
ALTER TABLE egress_settings ADD COLUMN IF NOT EXISTS pc_auth_key_expires_at TIMESTAMPTZ;
ALTER TABLE egress_settings ADD COLUMN IF NOT EXISTS pool_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE egress_settings ADD COLUMN IF NOT EXISTS max_numbers_per_pc INTEGER NOT NULL DEFAULT 5 CHECK (max_numbers_per_pc > 0);
ALTER TABLE egress_settings ADD COLUMN IF NOT EXISTS offline_grace_seconds INTEGER NOT NULL DEFAULT 180 CHECK (offline_grace_seconds >= 30);
