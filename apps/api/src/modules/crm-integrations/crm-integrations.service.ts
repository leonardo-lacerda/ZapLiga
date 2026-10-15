import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { SdrCapacityService } from '../billing/sdr-capacity.service';
import { EntitlementService } from '../billing/entitlement.service';
import { encryptSecret, hashCredential } from '../lead-ingestion/lead-ingestion.crypto';

export const INTEGRATION_SCOPES = ['calls', 'numbers:read', 'numbers:write', 'agents', 'webhooks'] as const;
export type IntegrationScope = typeof INTEGRATION_SCOPES[number];
export const CRM_CONTRACT_VERSION = 1;

export type CrmIntegration = {
  id: string; tenant_id: string; kind: string; name: string; public_id: string; api_key_prefix: string;
  scopes: string[]; status: string; webhook_url: string | null; allowed_origins: string[];
  external_account_id: string | null; connected_at: string | null; last_used_at: string | null;
  created_at: string; revoked_at: string | null;
};

const allowsPlainHttp = () => process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
const isLocalHost = (hostname: string) => hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost') || hostname.endsWith('.test');
const newApiKey = () => `zpl_crm_${randomBytes(30).toString('base64url')}`;

/** HTTPS everywhere; plain HTTP only for local hosts on a development/test API. */
export function normalizeIntegrationUrl(value: string, label: string) {
  let url: URL;
  try { url = new URL(String(value ?? '').trim()); } catch { throw new BadRequestException(`${label} inválida`); }
  const plainLocal = url.protocol === 'http:' && allowsPlainHttp() && isLocalHost(url.hostname);
  if (url.protocol !== 'https:' && !plainLocal) throw new BadRequestException(`${label} precisa usar HTTPS`);
  if (url.username || url.password) throw new BadRequestException(`${label} não pode conter credenciais`);
  return url;
}

export function normalizeOrigins(values: unknown) {
  if (values == null) return [] as string[];
  if (!Array.isArray(values)) throw new BadRequestException('allowedOrigins deve ser uma lista');
  return [...new Set(values.map((value) => normalizeIntegrationUrl(String(value), 'Origem').origin))].slice(0, 5);
}

@Injectable()
export class CrmIntegrationsService {
  constructor(private readonly db: DatabaseService, private readonly redis: RedisService, private readonly audit: AuditService, private readonly capacity: SdrCapacityService, private readonly entitlement: EntitlementService) {}

  publicView(row: any) {
    return {
      id: row.id, kind: row.kind, name: row.name, public_id: row.public_id, api_key_prefix: row.api_key_prefix,
      scopes: row.scopes ?? [], status: row.status, webhook_url: row.webhook_url ?? null, allowed_origins: row.allowed_origins ?? [],
      external_account_id: row.external_account_id ?? null, connected_at: row.connected_at ?? null, last_used_at: row.last_used_at ?? null,
      created_at: row.created_at, revoked_at: row.revoked_at ?? null,
    };
  }

  async list(tenantId: string) {
    const result = await this.db.query('SELECT * FROM crm_integrations WHERE tenant_id = $1 ORDER BY created_at DESC', [tenantId]);
    return result.rows.map((row) => this.publicView(row));
  }

  async create(tenantId: string, userId: string, input: { name: string; allowedOrigins?: string[] }) {
    const name = String(input.name ?? '').trim();
    if (name.length < 2 || name.length > 80) throw new BadRequestException('O nome da integração deve ter entre 2 e 80 caracteres');
    const allowedOrigins = normalizeOrigins(input.allowedOrigins);
    const apiKey = newApiKey();
    const row = (await this.db.query(`INSERT INTO crm_integrations (id, tenant_id, kind, name, public_id, api_key_prefix, api_key_hash, allowed_origins, created_by)
      VALUES ($1, $2, 'franco', $3, $4, $5, $6, $7, $8) RETURNING *`, [
      randomUUID(), tenantId, name, `crm_${randomBytes(12).toString('hex')}`, apiKey.slice(0, 16), hashCredential(apiKey), allowedOrigins, userId,
    ])).rows[0];
    await this.audit.record({ actorUserId: userId, tenantId, action: 'crm_integration.created', entityType: 'crm_integration', entityId: row.id });
    return { ...this.publicView(row), api_key: apiKey };
  }

  async rotate(tenantId: string, userId: string, id: string) {
    await this.findForTenant(tenantId, id);
    const apiKey = newApiKey();
    const row = (await this.db.query(`UPDATE crm_integrations SET api_key_prefix = $1, api_key_hash = $2, updated_at = now() WHERE tenant_id = $3 AND id = $4 AND status = 'active' RETURNING *`, [apiKey.slice(0, 16), hashCredential(apiKey), tenantId, id])).rows[0];
    if (!row) throw new BadRequestException('Uma integração revogada não pode ter a chave rotacionada');
    await this.audit.record({ actorUserId: userId, tenantId, action: 'crm_integration.key_rotated', entityType: 'crm_integration', entityId: id });
    return { ...this.publicView(row), api_key: apiKey };
  }

  async revoke(tenantId: string, userId: string, id: string) {
    await this.findForTenant(tenantId, id);
    const row = (await this.db.query(`UPDATE crm_integrations SET status = 'revoked', revoked_at = COALESCE(revoked_at, now()), updated_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING *`, [tenantId, id])).rows[0];
    await this.audit.record({ actorUserId: userId, tenantId, action: 'crm_integration.revoked', entityType: 'crm_integration', entityId: id });
    return this.publicView(row);
  }

  private async findForTenant(tenantId: string, id: string) {
    const result = await this.db.query('SELECT * FROM crm_integrations WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
    if (!result.rows[0]) throw new NotFoundException('Integração não encontrada');
    return result.rows[0];
  }

  /** Resolves an API key to its active integration (and active tenant), or null. */
  async authenticate(apiKey: string): Promise<CrmIntegration | null> {
    if (!apiKey.startsWith('zpl_crm_') || apiKey.length > 200) return null;
    const result = await this.db.query(`SELECT i.* FROM crm_integrations i JOIN tenants t ON t.id = i.tenant_id AND t.status = 'active'
      WHERE i.api_key_hash = $1 AND i.status = 'active' LIMIT 1`, [hashCredential(apiKey)]);
    return result.rows[0] ?? null;
  }

  /** Records usage at most once a minute per integration. */
  async touch(integration: CrmIntegration) {
    const first = await this.redis.client.set(`zapcall:crm-integration:${integration.id}:touched`, '1', 'EX', 60, 'NX').catch(() => null);
    if (first === 'OK') await this.db.query('UPDATE crm_integrations SET last_used_at = now() WHERE id = $1', [integration.id]).catch(() => undefined);
  }

  /**
   * The CRM registers where events go and which browser origins may open stations. Every
   * handshake issues a fresh webhook secret, returned only in this response.
   */
  async handshake(integration: CrmIntegration, input: { webhookUrl: string; allowedOrigins?: string[]; externalAccountId?: string }) {
    const webhookUrl = normalizeIntegrationUrl(input.webhookUrl, 'URL do webhook').toString();
    const allowedOrigins = input.allowedOrigins === undefined ? integration.allowed_origins : normalizeOrigins(input.allowedOrigins);
    const webhookSecret = `zpl_whsec_${randomBytes(30).toString('base64url')}`;
    const row = (await this.db.query(`UPDATE crm_integrations SET webhook_url = $1, webhook_secret_ciphertext = $2, allowed_origins = $3, external_account_id = COALESCE($4, external_account_id),
      connected_at = now(), updated_at = now() WHERE id = $5 RETURNING *`, [webhookUrl, encryptSecret(webhookSecret), allowedOrigins, input.externalAccountId?.trim() || null, integration.id])).rows[0];
    await this.audit.record({ tenantId: integration.tenant_id, action: 'crm_integration.handshake', entityType: 'crm_integration', entityId: integration.id, metadata: { webhookHost: new URL(webhookUrl).host } });
    return { integration: this.publicView(row), webhook_secret: webhookSecret, contract_version: CRM_CONTRACT_VERSION };
  }

  async me(integration: CrmIntegration) {
    const tenantId = integration.tenant_id;
    const [tenant, access, seats] = await Promise.all([
      this.db.query('SELECT id, name, timezone FROM tenants WHERE id = $1', [tenantId]),
      this.entitlement.getAccess(tenantId),
      this.capacity.read(tenantId),
    ]);
    return {
      contract_version: CRM_CONTRACT_VERSION,
      tenant: tenant.rows[0] ? { id: tenant.rows[0].id, name: tenant.rows[0].name, timezone: tenant.rows[0].timezone } : { id: tenantId },
      integration: this.publicView(integration),
      access: { mode: access.mode, reason: access.reason, plan_code: access.planCode ?? null, plan_name: access.planName ?? null },
      seats: { limit: seats.limit, used: seats.used, reserved: seats.reserved, available: seats.available },
    };
  }
}
