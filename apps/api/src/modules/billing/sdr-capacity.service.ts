import { ConflictException, HttpException, Injectable, Optional } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { EntitlementService } from './entitlement.service';
import { AuditService } from '../audit/audit.service';

type Executor = { query: (text: string, params?: unknown[]) => Promise<any> };

@Injectable()
export class SdrCapacityService {
  constructor(private readonly db: DatabaseService, private readonly entitlement: EntitlementService, @Optional() private readonly audit?: AuditService) {}

  async read(tenantId: string) {
    const result = await this.db.query(`
      SELECT COALESCE(e.max_sdrs, t.max_sdrs) AS max_sdrs, e.access_mode, e.access_reason,
        (SELECT count(*)::int FROM tenant_memberships tm WHERE tm.tenant_id = t.id AND tm.role = 'sdr' AND tm.status = 'active') AS used,
        (SELECT count(*)::int FROM invitations i WHERE i.tenant_id = t.id AND i.role = 'sdr' AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()) AS reserved
      FROM tenants t LEFT JOIN tenant_entitlements e ON e.tenant_id = t.id WHERE t.id = $1 LIMIT 1
    `, [tenantId]);
    const row = result.rows[0] ?? {};
    const limit = row.max_sdrs == null ? null : Number(row.max_sdrs);
    const used = Number(row.used ?? 0);
    const reserved = Number(row.reserved ?? 0);
    return { tenantId, limit, used, reserved, available: limit == null ? null : Math.max(0, limit - used - reserved), accessMode: row.access_mode ?? 'read_only', accessReason: row.access_reason ?? 'no_subscription' };
  }

  async assertCanAdd(tenantId: string, executor: Executor, options: { ignoreInvitationId?: string } = {}) {
    await this.entitlement.acquireTenantLock(tenantId, executor);
    const result = await executor.query(`
      SELECT t.status AS tenant_status, e.access_mode, e.access_until, e.max_sdrs, t.max_sdrs AS legacy_max_sdrs,
        (SELECT count(*)::int FROM tenant_memberships tm WHERE tm.tenant_id = t.id AND tm.role = 'sdr' AND tm.status = 'active') AS used,
        (SELECT count(*)::int FROM invitations i WHERE i.tenant_id = t.id AND i.role = 'sdr' AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now() AND ($2::text IS NULL OR i.id <> $2)) AS reserved
      FROM tenants t LEFT JOIN tenant_entitlements e ON e.tenant_id = t.id
      WHERE t.id = $1 LIMIT 1
    `, [tenantId, options.ignoreInvitationId ?? null]);
    const row = result.rows[0];
    if (!row || row.tenant_status !== 'active') throw new HttpException({ statusCode: 403, code: 'tenant_blocked', message: 'A empresa está bloqueada.' }, 403);
    const mode = this.entitlement.enforcementMode;
    const entitlementValid = row.access_mode === 'full' && row.access_until && new Date(row.access_until).getTime() > Date.now();
    if (mode === 'enforce' && !entitlementValid) throw new HttpException({ statusCode: 402, code: 'subscription_required', message: 'A organização está em modo somente leitura.', billingReason: row.access_reason ?? 'no_subscription', manageBilling: true }, 402);
    const limit = row.max_sdrs == null ? (mode === 'off' || mode === 'shadow' ? Number(row.legacy_max_sdrs ?? 0) : 0) : Number(row.max_sdrs);
    const used = Number(row.used ?? 0);
    const reserved = Number(row.reserved ?? 0);
    if (!limit || used + reserved >= limit) {
      await this.audit?.record({ tenantId, action: 'billing.sdr_limit_denied', entityType: 'tenant', entityId: tenantId, metadata: { used, reserved, limit } }).catch(() => undefined);
      throw new ConflictException({ code: 'sdr_limit_reached', message: 'O limite de SDRs desta empresa foi atingido.', used, reserved, limit, available: 0 });
    }
    return { used, reserved, limit, available: limit - used - reserved };
  }
}
