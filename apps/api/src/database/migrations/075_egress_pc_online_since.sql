-- Since when the slot has been going out through its PC without a break. A PC only
-- receives lines (new ones or moved by the pool) after a steady stretch online, so a
-- PC that comes and goes does not take back the lines that just left it.
ALTER TABLE egress_pcs ADD COLUMN IF NOT EXISTS online_since TIMESTAMPTZ;
