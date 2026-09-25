import { HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { BillingAction, BillingAccessMode, FeatureEntitlements, LimitEntitlements, TenantAccess, mutatingBillingActions } from './billing.types';

const toDate = (seconds: unknown) => {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? new Date(value * 1000) : null;
};

const envMode = (): 'off' | 'shadow' | 'enforce' => {
  const configured = process.env.BILLING_ENFORCEMENT_MODE?.trim().toLowerCase();
  const isDevelopmentLike = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
  const value = configured || (isDevelopmentLike ? 'off' : 'enforce');
  return value === 'enforce' || value === 'shadow' ? value : 'off';
};

const ADMIN_WRITE_MODE_TTL_SECONDS = 8 * 60 * 60;

const objectOrEmpty =<T extends object>(value: unknown): T => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as T : {} as T
);

@Injectable()
export class EntitlementService {
  private readonly logger = new Logger(EntitlementService.name);

  constructor(private readonly db: DatabaseService, private readonly redis: RedisService, private readonly audit: AuditService) {}

  private get livemode() {
    return String(process.env.STRIPE_LIVEMODE ?? 'false').toLowerCase() === 'true';
  }

  get enforcementMode() { return envMode(); }

  async getAccess(tenantId: string): Promise<TenantAccess> {
    const result = await this.db.query(`
      SELECT t.status AS tenant_status,
        e.access_mode, e.access_reason, e.access_until, e.max_sdrs, e.included_sdrs,
        e.purchased_extra_sdrs, e.feature_entitlements, e.limit_entitlements,
        e.last_active_feature_entitlements, e.catalog_version, e.subscription_quantity_version, e.source,
        pv.code AS plan_code, pv.display_name AS plan_name, pv.max_sdrs AS plan_max_sdrs,
        ts.cancel_at_period_end,
        COALESCE((SELECT count(*)::int FROM tenant_memberships tm WHERE tm.tenant_id = t.id AND tm.role = 'sdr' AND tm.status = 'active'), 0) AS used_sdr_seats,
        COALESCE((SELECT count(*)::int FROM invitations i WHERE i.tenant_id = t.id AND i.role = 'sdr' AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()), 0) AS reserved_sdr_seats
      FROM tenants t
      LEFT JOIN tenant_entitlements e ON e.tenant_id = t.id
      LEFT JOIN billing_plan_versions pv ON pv.id = e.plan_version_id
      LEFT JOIN LATERAL (
        SELECT cancel_at_period_end
        FROM tenant_subscriptions
        WHERE tenant_id = t.id AND livemode = $2
        ORDER BY updated_at DESC
        LIMIT 1
      ) ts ON true
      WHERE t.id = $1
      LIMIT 1
    `, [tenantId, this.livemode]);
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Empresa não encontrada');
    const accessUntil = row.access_until ? new Date(row.access_until) : null;
    let mode: BillingAccessMode = row.tenant_status !== 'active' ? 'blocked' : (row.access_mode ?? 'read_only');
    let reason = String(row.access_reason ?? 'no_subscription');
    if (mode === 'full' && accessUntil && accessUntil.getTime() <= Date.now()) {
      mode = 'read_only';
      reason = 'subscription_expired';
    }
    const overrides = await this.db.query(`SELECT feature_code, override_mode, value FROM tenant_entitlement_overrides WHERE tenant_id = $1 AND revoked_at IS NULL AND starts_at <= now() AND (expires_at IS NULL OR expires_at > now())`, [tenantId]);
    const featureEntitlements = objectOrEmpty<FeatureEntitlements>(row.feature_entitlements);
    const limitEntitlements = objectOrEmpty<LimitEntitlements>(row.limit_entitlements);
    for (const override of overrides.rows) {
      if (override.feature_code && (override.override_mode === 'grant' || override.override_mode === 'deny')) featureEntitlements[String(override.feature_code)] = override.override_mode === 'deny' ? 'none' : ((override.value?.level ?? 'full') as any);
      if (override.feature_code && override.override_mode === 'replace_limit' && Number.isFinite(Number(override.value?.value))) limitEntitlements[String(override.feature_code)] = Number(override.value.value);
    }
    return {
      tenantId,
      mode,
      reason,
      enforcementMode: this.enforcementMode,
      accessUntil: accessUntil?.toISOString() ?? null,
      planCode: row.plan_code ?? null,
      planName: row.plan_name ?? null,
      maxSdrs: row.max_sdrs == null ? null : Number(row.max_sdrs),
      planMaxSdrs: row.plan_max_sdrs == null ? (row.source === 'manual_grant' && row.max_sdrs != null ? Number(row.max_sdrs) : null) : Number(row.plan_max_sdrs),
      includedSdrs: row.included_sdrs == null ? null : Number(row.included_sdrs),
      purchasedExtraSdrs: Number(row.purchased_extra_sdrs ?? 0),
      featureEntitlements,
      limitEntitlements,
      lastActiveFeatureEntitlements: objectOrEmpty<FeatureEntitlements>(row.last_active_feature_entitlements),
      catalogVersion: Number(row.catalog_version ?? 1),
      subscriptionQuantityVersion: Number(row.subscription_quantity_version ?? 0),
      usedSdrSeats: Number(row.used_sdr_seats ?? 0),
      reservedSdrSeats: Number(row.reserved_sdr_seats ?? 0),
      cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
      source: row.source ?? 'none',
    };
  }

  async decorateTenantRows(rows: any[]) {
    return Promise.all(rows.map(async (row) => ({ ...row, billing: await this.getAccess(String(row.id)) })));
  }

  /**
   * `sanctionedBy`: the user who authorized this write earlier, when the actor is someone else --
   * e.g. the invitee accepting an invitation. An invitation a super admin sent on a read-only
   * tenant is an admin decision and must be acceptable, otherwise admin edit mode only half works.
   */
  async assertAction(tenantId: string, action: BillingAction, actorUserId?: string, options: { sanctionedBy?: string } = {}) {
    const access = await this.getAccess(tenantId);
    // Finishing an already-running call is allowed while a tenant is
    // read-only, but an administratively blocked tenant must still be denied.
    if (action === 'call_finalize' && access.mode === 'blocked' && this.enforcementMode === 'enforce') {
      throw new HttpException({ statusCode: 403, code: 'tenant_blocked', message: 'A empresa está bloqueada.' }, 403);
    }
    if (!mutatingBillingActions.has(action) || access.mode === 'full') return access;
    const mode = this.enforcementMode;
    if (mode === 'shadow') {
      this.logger.warn(`billing shadow denial tenant=${tenantId} action=${action} reason=${access.reason}`);
      await this.audit.record({ actorUserId: actorUserId ?? null, tenantId, action: 'billing.action_denied_shadow', entityType: 'tenant', entityId: tenantId, metadata: { requestedAction: action, reason: access.reason } }).catch(() => undefined);
      return access;
    }
    if (mode === 'off') return access;
    if (access.mode === 'read_only' && ((actorUserId && await this.hasAdminWriteMode(actorUserId)) || (options.sanctionedBy && await this.isSuperAdmin(options.sanctionedBy)))) {
      await this.audit.record({ actorUserId: actorUserId ?? null, tenantId, action: 'billing.admin_write_override', entityType: 'tenant', entityId: tenantId, metadata: { requestedAction: action, reason: access.reason, sanctionedBy: options.sanctionedBy ?? null } }).catch(() => undefined);
      return access;
    }
    await this.redis.incrementMetric('billing_action_denied_total').catch(() => undefined);
    await this.audit.record({ actorUserId: actorUserId ?? null, tenantId, action: 'billing.action_denied', entityType: 'tenant', entityId: tenantId, metadata: { requestedAction: action, reason: access.reason } }).catch(() => undefined);
    throw new HttpException({ statusCode: 402, code: 'subscription_required', message: 'A organização está em modo somente leitura.', billingReason: access.reason, manageBilling: true }, 402);
  }

  /**
   * Super-admin "edit mode": lets a platform admin act on a read-only tenant (support work)
   * without granting the tenant itself anything. Per admin, stored in Redis with a TTL so it
   * cannot be left on forever, and re-checked against the user's current platform role so a
   * demoted admin loses it immediately. Blocked tenants stay blocked.
   */
  private adminWriteModeKey(userId: string) { return `zapcall:admin-write-mode:${userId}`; }

  async isSuperAdmin(userId: string) {
    try {
      const user = await this.db.query('SELECT platform_role FROM users WHERE id = $1 LIMIT 1', [userId]);
      return user.rows[0]?.platform_role === 'super_admin';
    } catch {
      return false;
    }
  }

  async hasAdminWriteMode(userId: string) {
    // Fails closed: any lookup error keeps the tenant read-only.
    try {
      const flag = await this.redis.client.get(this.adminWriteModeKey(userId));
      if (!flag) return false;
      const user = await this.db.query('SELECT platform_role FROM users WHERE id = $1 LIMIT 1', [userId]);
      return user.rows[0]?.platform_role === 'super_admin';
    } catch {
      return false;
    }
  }

  async getAdminWriteMode(userId: string) {
    const ttl = await this.redis.client.ttl(this.adminWriteModeKey(userId)).catch(() => -2);
    return { enabled: ttl > 0, expiresAt: ttl > 0 ? new Date(Date.now() + ttl * 1000).toISOString() : null };
  }

  async setAdminWriteMode(userId: string, enabled: boolean) {
    if (enabled) await this.redis.client.set(this.adminWriteModeKey(userId), '1', 'EX', ADMIN_WRITE_MODE_TTL_SECONDS);
    else await this.redis.client.del(this.adminWriteModeKey(userId));
    await this.audit.record({ actorUserId: userId, tenantId: null, action: enabled ? 'billing.admin_write_mode_enabled' : 'billing.admin_write_mode_disabled', entityType: 'user', entityId: userId }).catch(() => undefined);
    return this.getAdminWriteMode(userId);
  }

  async assertCanOperate(tenantId: string, actorUserId?: string) { return this.assertAction(tenantId, 'operate', actorUserId); }

  async assertCanFinalize(tenantId: string) {
    const access = await this.getAccess(tenantId);
    if (access.mode === 'blocked' && this.enforcementMode === 'enforce') throw new HttpException({ statusCode: 403, code: 'tenant_blocked', message: 'A empresa está bloqueada.' }, 403);
    return access;
  }

  async recompute(tenantId: string, executor: { query: (text: string, params?: unknown[]) => Promise<any> } = this.db) {
    const tenant = await executor.query('SELECT status FROM tenants WHERE id = $1 LIMIT 1', [tenantId]);
    if (!tenant.rows[0]) throw new NotFoundException('Empresa não encontrada');
    const grant = await executor.query(`
      SELECT max_sdrs FROM billing_manual_grants
      WHERE tenant_id = $1 AND revoked_at IS NULL AND starts_at <= now() AND expires_at > now()
      ORDER BY expires_at DESC LIMIT 1
    `, [tenantId]);
    const subscription = await executor.query(`
      SELECT ts.*, pv.code AS plan_code, pv.display_name AS plan_name, pv.max_sdrs,
        pv.included_sdrs, pv.feature_entitlements, pv.limit_entitlements
      FROM tenant_subscriptions ts
      LEFT JOIN billing_plan_versions pv ON pv.id = ts.plan_version_id
      WHERE ts.tenant_id = $1 AND ts.livemode = $2
      ORDER BY ts.updated_at DESC LIMIT 1
    `, [tenantId, this.livemode]);
    let mode: BillingAccessMode = tenant.rows[0].status !== 'active' ? 'blocked' : 'read_only';
    let reason = tenant.rows[0].status !== 'active' ? 'tenant_blocked' : 'no_subscription';
    let source = 'none';
    let accessUntil: Date | null = null;
    let maxSdrs: number | null = null;
    let planMaxSdrs: number | null = null;
    let planVersionId: string | null = null;
    let includedSdrs: number | null = null;
    let purchasedExtraSdrs = 0;
    let featureEntitlements: FeatureEntitlements = {};
    let limitEntitlements: LimitEntitlements = {};
    let lastActiveFeatureEntitlements: FeatureEntitlements = {};
    let subscriptionQuantityVersion = 0;
    const previous = await executor.query('SELECT last_active_feature_entitlements, subscription_quantity_version FROM tenant_entitlements WHERE tenant_id = $1 LIMIT 1', [tenantId]);
    lastActiveFeatureEntitlements = objectOrEmpty<FeatureEntitlements>(previous.rows[0]?.last_active_feature_entitlements);
    if (grant.rows[0] && mode !== 'blocked') {
      mode = 'full'; reason = 'manual_grant'; source = 'manual_grant'; maxSdrs = Number(grant.rows[0].max_sdrs); planMaxSdrs = maxSdrs;
      const activeGrant = await executor.query(`SELECT expires_at FROM billing_manual_grants WHERE tenant_id = $1 AND revoked_at IS NULL AND starts_at <= now() AND expires_at > now() ORDER BY expires_at DESC LIMIT 1`, [tenantId]);
      accessUntil = activeGrant.rows[0]?.expires_at ? new Date(activeGrant.rows[0].expires_at) : null;
    } else if (subscription.rows[0] && mode !== 'blocked') {
      const sub = subscription.rows[0];
      const status = String(sub.status);
      const candidateUntil = sub.access_until ? new Date(sub.access_until) : null;
      if ((status === 'active' || status === 'trialing') && candidateUntil && candidateUntil.getTime() > Date.now() && sub.plan_version_id) {
        mode = 'full'; reason = status === 'trialing' ? 'trialing' : 'active_subscription'; source = 'stripe';
        includedSdrs = Number(sub.included_sdrs ?? sub.max_sdrs ?? 0) || null;
        planMaxSdrs = Number(sub.max_sdrs ?? includedSdrs ?? 0) || null;
        featureEntitlements = objectOrEmpty<FeatureEntitlements>(sub.feature_entitlements);
        limitEntitlements = objectOrEmpty<LimitEntitlements>(sub.limit_entitlements);
        const items = await executor.query(`SELECT COALESCE(SUM(quantity), 0)::int AS purchased_extra_sdrs, COALESCE(MAX(updated_at), now()) AS quantity_version FROM tenant_subscription_items WHERE tenant_subscription_id = $1 AND item_kind = 'sdr_seat'`, [sub.id]);
        purchasedExtraSdrs = Math.max(0, Number(items.rows[0]?.purchased_extra_sdrs ?? 0));
        subscriptionQuantityVersion = items.rows[0]?.quantity_version ? new Date(items.rows[0].quantity_version).getTime() : 0;
        maxSdrs = Math.min(planMaxSdrs ?? Number(includedSdrs ?? 0), (includedSdrs ?? 0) + purchasedExtraSdrs) || null;
        planVersionId = sub.plan_version_id; accessUntil = candidateUntil;
        lastActiveFeatureEntitlements = featureEntitlements;
      } else {
        reason = status || 'no_subscription'; source = 'stripe'; maxSdrs = sub.max_sdrs == null ? null : Number(sub.max_sdrs); planMaxSdrs = maxSdrs; planVersionId = sub.plan_version_id ?? null;
        includedSdrs = sub.included_sdrs == null ? null : Number(sub.included_sdrs);
        featureEntitlements = objectOrEmpty<FeatureEntitlements>(sub.feature_entitlements);
        limitEntitlements = objectOrEmpty<LimitEntitlements>(sub.limit_entitlements);
      }
    }
    await executor.query(`
      INSERT INTO tenant_entitlements (tenant_id, plan_version_id, access_mode, access_reason, access_until, max_sdrs, included_sdrs, purchased_extra_sdrs, feature_entitlements, limit_entitlements, last_active_feature_entitlements, catalog_version, subscription_quantity_version, source, computed_at, version, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, 1, $12, $13, now(), 1, now())
      ON CONFLICT (tenant_id) DO UPDATE SET plan_version_id = EXCLUDED.plan_version_id,
        access_mode = EXCLUDED.access_mode, access_reason = EXCLUDED.access_reason,
        access_until = EXCLUDED.access_until, max_sdrs = EXCLUDED.max_sdrs,
        included_sdrs = EXCLUDED.included_sdrs, purchased_extra_sdrs = EXCLUDED.purchased_extra_sdrs,
        feature_entitlements = EXCLUDED.feature_entitlements, limit_entitlements = EXCLUDED.limit_entitlements,
        last_active_feature_entitlements = CASE WHEN EXCLUDED.access_mode = 'full' THEN EXCLUDED.last_active_feature_entitlements ELSE tenant_entitlements.last_active_feature_entitlements END,
        subscription_quantity_version = EXCLUDED.subscription_quantity_version,
        source = EXCLUDED.source, computed_at = now(), version = tenant_entitlements.version + 1, updated_at = now()
    `, [tenantId, planVersionId, mode, reason, accessUntil, maxSdrs, includedSdrs, purchasedExtraSdrs, JSON.stringify(featureEntitlements), JSON.stringify(limitEntitlements), JSON.stringify(lastActiveFeatureEntitlements), subscriptionQuantityVersion, source]);
    // Invalidate both the entitlement namespace and the feature projection.
    // A paid invoice must make the plan's resources visible immediately, not
    // only after the feature-flag cache's 60-second TTL expires.
    await this.redis.client.del(`zapcall:billing:tenant:${tenantId}`, `zapcall:tenant:${tenantId}:feature-flags`).catch(() => undefined);
    // When recompute runs inside a transaction, reading through the pool here
    // would not see the uncommitted entitlement row. Callers only need the
    // projection after commit, so return the deterministic values instead.
    return { tenantId, mode, reason, accessUntil: accessUntil?.toISOString() ?? null, maxSdrs, planMaxSdrs, includedSdrs, purchasedExtraSdrs, featureEntitlements, limitEntitlements, source, planVersionId };
  }

  async acquireTenantLock(tenantId: string, executor: { query: (text: string, params?: unknown[]) => Promise<any> }) {
    await executor.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`billing-tenant:${tenantId}`]);
  }

  async createManualGrant(tenantId: string, input: { startsAt: Date; expiresAt: Date; maxSdrs: number; reason: string; actorUserId: string }) {
    if (!input.reason.trim() || !Number.isInteger(input.maxSdrs) || input.maxSdrs < 1 || input.maxSdrs > 100000 || Number.isNaN(input.startsAt.getTime()) || Number.isNaN(input.expiresAt.getTime()) || input.expiresAt <= input.startsAt) {
      throw new HttpException({ statusCode: 400, code: 'invalid_manual_grant', message: 'Concessão manual inválida.' }, 400);
    }
    const id = randomUUID();
    await this.db.transaction(async (client) => {
      await this.acquireTenantLock(tenantId, client);
      await client.query(`INSERT INTO billing_manual_grants (id, tenant_id, starts_at, expires_at, max_sdrs, reason, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, tenantId, input.startsAt, input.expiresAt, input.maxSdrs, input.reason.trim(), input.actorUserId]);
      await this.recompute(tenantId, client);
    });
    await this.audit.record({ actorUserId: input.actorUserId, tenantId, action: 'billing.manual_grant_created', entityType: 'billing_manual_grant', entityId: id, metadata: { startsAt: input.startsAt.toISOString(), expiresAt: input.expiresAt.toISOString(), maxSdrs: input.maxSdrs } });
    return { id, tenantId, ...input, actorUserId: undefined };
  }

  async revokeManualGrant(tenantId: string, id: string, actorUserId: string) {
    const result = await this.db.transaction(async (client) => {
      await this.acquireTenantLock(tenantId, client);
      const updated = await client.query('UPDATE billing_manual_grants SET revoked_at = now(), revoked_by = $1 WHERE id = $2 AND tenant_id = $3 AND revoked_at IS NULL RETURNING id', [actorUserId, id, tenantId]);
      if (!updated.rows[0]) return null;
      await this.recompute(tenantId, client);
      return updated.rows[0];
    });
    if (!result) throw new NotFoundException('Concessão manual não encontrada');
    await this.audit.record({ actorUserId, tenantId, action: 'billing.manual_grant_revoked', entityType: 'billing_manual_grant', entityId: id });
    return { ok: true, id };
  }

  async createOverride(tenantId: string, input: { featureCode?: string; overrideMode: 'grant' | 'deny' | 'replace_limit'; value?: Record<string, unknown>; reason: string; expiresInSeconds?: number; actorUserId: string }) {
    if (!input.reason.trim() || (input.overrideMode === 'grant' && (!input.expiresInSeconds || input.expiresInSeconds <= 0)) || (input.overrideMode === 'replace_limit' && !Number.isFinite(Number(input.value?.value)))) throw new HttpException({ statusCode: 400, code: 'invalid_entitlement_override', message: 'Override de entitlement invalido.' }, 400);
    const id = randomUUID();
    const expiresAt = input.expiresInSeconds ? new Date(Date.now() + input.expiresInSeconds * 1000) : null;
    await this.db.query(`INSERT INTO tenant_entitlement_overrides (id, tenant_id, feature_code, override_mode, value, reason, created_by, expires_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`, [id, tenantId, input.featureCode?.trim() || null, input.overrideMode, JSON.stringify(input.value ?? {}), input.reason.trim(), input.actorUserId, expiresAt]);
    await this.redis.client.del(`zapcall:tenant:${tenantId}:feature-flags`).catch(() => undefined);
    await this.audit.record({ actorUserId: input.actorUserId, tenantId, action: 'billing.entitlement_override_created', entityType: 'tenant_entitlement_override', entityId: id, metadata: { featureCode: input.featureCode, overrideMode: input.overrideMode, expiresAt: expiresAt?.toISOString() ?? null } });
    return { id, tenantId, featureCode: input.featureCode ?? null, overrideMode: input.overrideMode, expiresAt };
  }

  async revokeOverride(tenantId: string, id: string, actorUserId: string) {
    const result = await this.db.query(`UPDATE tenant_entitlement_overrides SET revoked_at = now(), revoked_by = $1 WHERE id = $2 AND tenant_id = $3 AND revoked_at IS NULL RETURNING id`, [actorUserId, id, tenantId]);
    if (!result.rows[0]) throw new NotFoundException('Override de entitlement nao encontrado');
    await this.redis.client.del(`zapcall:tenant:${tenantId}:feature-flags`).catch(() => undefined);
    await this.audit.record({ actorUserId, tenantId, action: 'billing.entitlement_override_revoked', entityType: 'tenant_entitlement_override', entityId: id });
    return { ok: true, id };
  }

  static providerDate(value: unknown) { return toDate(value); }
}
