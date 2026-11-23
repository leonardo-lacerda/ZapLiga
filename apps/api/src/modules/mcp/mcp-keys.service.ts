import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { hashCredential } from '../lead-ingestion/lead-ingestion.crypto';

/**
 * What a key may do through the MCP:
 * - `mcp:read`: list phones, PCs, numbers and registrations, see the phone screen;
 * - `mcp:operate`: power phones on and off, touch the screen, drive a registration, link and reconnect lines;
 * - `mcp:destructive`: delete a phone or give it a new device (off unless asked for).
 */
export const MCP_SCOPES = ['mcp:read', 'mcp:operate', 'mcp:destructive'] as const;
export type McpScope = typeof MCP_SCOPES[number];
export const DEFAULT_MCP_SCOPES: McpScope[] = ['mcp:read', 'mcp:operate'];
const KEY_PREFIX = 'zpl_mcp_';

export type McpKey = {
  id: string; tenant_id: string; user_id: string; name: string; api_key_prefix: string;
  scopes: McpScope[]; status: string; last_used_at: Date | string | null; created_at: Date | string; revoked_at: Date | string | null;
};

@Injectable()
export class McpKeysService {
  constructor(private readonly db: DatabaseService, private readonly redis: RedisService, private readonly audit: AuditService) {}

  publicView(row: McpKey & { user_name?: string | null }) {
    return {
      id: row.id, name: row.name, prefix: row.api_key_prefix, scopes: row.scopes ?? [], status: row.status,
      userId: row.user_id, userName: row.user_name ?? null,
      lastUsedAt: row.last_used_at ?? null, createdAt: row.created_at, revokedAt: row.revoked_at ?? null,
    };
  }

  async list(tenantId: string) {
    const result = await this.db.query(`SELECT k.*, u.name AS user_name FROM mcp_keys k LEFT JOIN users u ON u.id = k.user_id
      WHERE k.tenant_id = $1 ORDER BY k.created_at DESC`, [tenantId]);
    return { items: result.rows.map((row: McpKey) => this.publicView(row)) };
  }

  /** The key is returned once, here; only its hash is stored. */
  async create(tenantId: string, userId: string, input: { name: string; scopes?: string[] }) {
    const name = String(input.name ?? '').trim();
    if (name.length < 2 || name.length > 80) throw new BadRequestException('O nome da chave deve ter entre 2 e 80 caracteres');
    const scopes = input.scopes?.length ? [...new Set(input.scopes)] : DEFAULT_MCP_SCOPES;
    if (scopes.some((scope) => !(MCP_SCOPES as readonly string[]).includes(scope))) throw new BadRequestException('Escopo inválido');
    if (!scopes.includes('mcp:read')) throw new BadRequestException('A chave precisa de mcp:read');
    const apiKey = `${KEY_PREFIX}${randomBytes(30).toString('base64url')}`;
    const row = (await this.db.query(`INSERT INTO mcp_keys (id, tenant_id, user_id, name, api_key_prefix, api_key_hash, scopes)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`, [randomUUID(), tenantId, userId, name, apiKey.slice(0, 16), hashCredential(apiKey), scopes])).rows[0] as McpKey;
    await this.audit.record({ actorUserId: userId, tenantId, action: 'mcp_key.created', entityType: 'mcp_key', entityId: row.id, metadata: { scopes } });
    return { ...this.publicView(row), apiKey };
  }

  async revoke(tenantId: string, userId: string, id: string) {
    const row = (await this.db.query(`UPDATE mcp_keys SET status = 'revoked', revoked_at = COALESCE(revoked_at, now())
      WHERE tenant_id = $1 AND id = $2 RETURNING *`, [tenantId, id])).rows[0] as McpKey | undefined;
    if (!row) throw new NotFoundException('Chave não encontrada');
    await this.audit.record({ actorUserId: userId, tenantId, action: 'mcp_key.revoked', entityType: 'mcp_key', entityId: id });
    return this.publicView(row);
  }

  /** Active key of an active tenant and an existing user, or null. */
  async authenticate(apiKey: string): Promise<McpKey | null> {
    if (!apiKey.startsWith(KEY_PREFIX) || apiKey.length > 200) return null;
    const result = await this.db.query(`SELECT k.* FROM mcp_keys k JOIN tenants t ON t.id = k.tenant_id AND t.status = 'active'
      JOIN users u ON u.id = k.user_id WHERE k.api_key_hash = $1 AND k.status = 'active' LIMIT 1`, [hashCredential(apiKey)]);
    return (result.rows[0] as McpKey | undefined) ?? null;
  }

  /** Records usage at most once a minute per key. */
  async touch(key: McpKey) {
    const first = await this.redis.client.set(`zapcall:mcp-key:${key.id}:touched`, '1', 'EX', 60, 'NX').catch(() => null);
    if (first === 'OK') await this.db.query('UPDATE mcp_keys SET last_used_at = now() WHERE id = $1', [key.id]).catch(() => undefined);
  }
}
