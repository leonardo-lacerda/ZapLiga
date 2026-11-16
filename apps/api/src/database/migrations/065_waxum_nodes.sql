-- Which Waxum holds the line's WhatsApp session. `main` is the shared Waxum that
-- goes out through the VPS; the others go out through an attendant's PC
-- (docs/saida-pelo-pc-do-atendente.md). The URLs live in WAXUM_URL/WAXUM_EDGE_NODES.
ALTER TABLE whatsapp_numbers ADD COLUMN IF NOT EXISTS waxum_node TEXT NOT NULL DEFAULT 'main';
