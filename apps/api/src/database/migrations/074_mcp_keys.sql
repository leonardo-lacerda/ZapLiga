-- Chaves do MCP do ZapLiga (docs/mcp.md): o Claude opera telefones, cadastros e números pela
-- rota POST /mcp com uma destas chaves. Uma chave por pessoa: as ações entram na auditoria em
-- nome de quem criou a chave. Só o hash fica guardado; a chave aparece uma vez, ao criar.
CREATE TABLE IF NOT EXISTS mcp_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  api_key_prefix TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT[] NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS mcp_keys_tenant_idx ON mcp_keys (tenant_id, created_at DESC);
