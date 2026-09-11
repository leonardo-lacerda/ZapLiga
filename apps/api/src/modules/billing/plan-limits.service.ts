import { ConflictException, HttpException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { EntitlementService } from './entitlement.service';

type Executor = { query: (text: string, params?: unknown[]) => Promise<any> };

/** Enforces operational limits from the effective commercial snapshot. */
@Injectable()
export class PlanLimitsService {
  constructor(private readonly db: DatabaseService, private readonly entitlement: EntitlementService) {}

  /**
   * Capacity writers can acquire this lock before their domain-specific lock
   * (for example lead-quota). Keeping one lock order avoids deadlocks while
   * the actual count and INSERT remain in the same transaction.
   */
  async acquireTenantLock(tenantId: string, executor: Executor = this.db) {
    await this.entitlement.acquireTenantLock(tenantId, executor);
  }

  private async snapshot(tenantId: string, executor: Executor = this.db) {
    const access = await this.entitlement.getAccess(tenantId);
    const row = (await executor.query('SELECT limit_entitlements FROM tenant_entitlements WHERE tenant_id = $1 LIMIT 1', [tenantId])).rows[0];
    const limits = row?.limit_entitlements && typeof row.limit_entitlements === 'object' ? row.limit_entitlements as Record<string, unknown> : {};
    return { access, limits };
  }

  private ensureWritable(tenantId: string, access: Awaited<ReturnType<EntitlementService['getAccess']>>) {
    if (access.mode === 'blocked') throw new HttpException({ statusCode: 403, code: 'tenant_blocked', message: 'A organização está bloqueada.' }, 403);
    if (this.entitlement.enforcementMode === 'enforce' && access.mode !== 'full') throw new HttpException({ statusCode: 402, code: 'subscription_required', message: 'Assinatura ativa necessária para usar este limite.', billingReason: access.reason, manageBilling: true }, 402);
  }

  private numeric(limits: Record<string, unknown>, key: string, fallback: number) {
    const value = Number(limits[key]);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  }

  async assertCanAddNumbers(tenantId: string, executor: Executor = this.db, additional = 1) {
    await this.entitlement.acquireTenantLock(tenantId, executor);
    const { access, limits } = await this.snapshot(tenantId, executor);
    this.ensureWritable(tenantId, access);
    const limit = this.numeric(limits, 'numbers', 10_000);
    const current = Number((await executor.query("SELECT count(*)::int AS count FROM whatsapp_numbers WHERE tenant_id = $1 AND status <> 'removed'", [tenantId])).rows[0]?.count ?? 0);
    if (current + additional > limit) throw new ConflictException({ code: 'number_limit_reached', message: 'O plano atingiu o limite de números.', used: current, limit, available: Math.max(0, limit - current) });
    return { used: current, limit, available: Math.max(0, limit - current - additional) };
  }

  async assertCanAddLeads(tenantId: string, executor: Executor = this.db, additional = 1) {
    await this.entitlement.acquireTenantLock(tenantId, executor);
    const { access, limits } = await this.snapshot(tenantId, executor);
    this.ensureWritable(tenantId, access);
    const legacy = Number((await executor.query('SELECT max_leads FROM tenants WHERE id = $1 LIMIT 1', [tenantId])).rows[0]?.max_leads ?? 100_000);
    const limit = this.numeric(limits, 'leads', legacy);
    const current = Number((await executor.query('SELECT count(*)::int AS count FROM leads WHERE tenant_id = $1', [tenantId])).rows[0]?.count ?? 0);
    if (current + additional > limit) throw new ConflictException({ code: 'lead_limit_reached', message: 'O plano atingiu o limite de leads.', used: current, limit, available: Math.max(0, limit - current) });
    return { used: current, limit, available: Math.max(0, limit - current - additional) };
  }

  async assertCanReserveCall(tenantId: string, executor: Executor = this.db) {
    await this.entitlement.acquireTenantLock(tenantId, executor);
    const { access, limits } = await this.snapshot(tenantId, executor);
    this.ensureWritable(tenantId, access);
    const limit = this.numeric(limits, 'max_concurrent_dialers', 1);
    const current = Number((await executor.query("SELECT count(*)::int AS count FROM calls WHERE tenant_id = $1 AND status IN ('reserved','dialing','media_active')", [tenantId])).rows[0]?.count ?? 0);
    if (current >= limit) throw new ConflictException({ code: 'concurrent_call_limit_reached', message: 'O plano atingiu o limite de chamadas simultâneas.', used: current, limit, available: 0 });
    return { used: current, limit, available: limit - current - 1 };
  }

  async getLimits(tenantId: string) {
    const { access, limits } = await this.snapshot(tenantId);
    return { ...access, limits };
  }
}
