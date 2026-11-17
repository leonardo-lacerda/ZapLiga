-- Internet exit through an attendant's PC (docs/saida-pelo-pc-do-atendente.md).

-- Which Waxum holds the line's WhatsApp session. `main` is the shared Waxum that
-- goes out through the VPS; the others (`edge-1`…) are the PC slots in
-- docker-compose.yml, listed in WAXUM_EDGE_NODES.
ALTER TABLE whatsapp_numbers ADD COLUMN IF NOT EXISTS waxum_node TEXT NOT NULL DEFAULT 'main';

-- The Tailscale OAuth client the API uses to create join keys and find the PCs.
-- Saved from Admin → Saídas de internet; a single row.
CREATE TABLE IF NOT EXISTS egress_settings (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  tailscale_client_id TEXT NOT NULL,
  -- encryptSecret() with DATA_PROTECTION_SECRET.
  tailscale_client_secret TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One attendant PC per slot. `route` is what the slot's watcher last reported:
-- pc (going out through the PC), offline (PC down, lines held), vps (PC down,
-- going out through the VPS) or idle.
CREATE TABLE IF NOT EXISTS egress_pcs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slot TEXT NOT NULL UNIQUE,
  tailscale_hostname TEXT NOT NULL UNIQUE,
  tailscale_device_id TEXT,
  tailscale_ip TEXT,
  fallback TEXT NOT NULL DEFAULT 'offline' CHECK (fallback IN ('offline', 'vps')),
  route TEXT,
  route_reported_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
