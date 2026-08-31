import { ConflictException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { AuditService } from '../audit/audit.service';

export const TENANT_FEATURES = ['schedule_enforcement', 'callbacks', 'privacy_requests', 'onboarding'] as const;
export type TenantFeature = typeof TENANT_FEATURES[number];
export type TenantFeatureFlags = Record<TenantFeature, boolean>;
const defaults = (): TenantFeatureFlags => ({ schedule_enforcement: false, callbacks: false, privacy_requests: false, onboarding: false });

@Injectable()
export class FeatureFlagsService {
  constructor(private readonly db: DatabaseService, private readonly redis: RedisService, private readonly audit: AuditService) {}
  private key(tenantId: string) { return `zapcall:tenant:${tenantId}:feature-flags`; }
  async get(tenantId: string): Promise<TenantFeatureFlags> {
    const cached = await this.redis.client.get(this.key(tenantId)).catch(() => null);
    if (cached) { try { return { ...defaults(), ...JSON.parse(cached) }; } catch { await this.redis.client.del(this.key(tenantId)).catch(() => undefined); } }
    const row = (await this.db.query('SELECT schedule_enforcement, callbacks, privacy_requests, onboarding FROM tenant_feature_flags WHERE tenant_id = $1', [tenantId])).rows[0];
    const flags = { ...defaults(), ...(row ?? {}) };
    await this.redis.client.set(this.key(tenantId), JSON.stringify(flags), 'EX', 60).catch(() => undefined);
    return flags;
  }
  async enabled(tenantId: string, feature: TenantFeature) { return (await this.get(tenantId))[feature]; }
  async assertEnabled(tenantId: string, feature: TenantFeature) {
    if (!(await this.enabled(tenantId, feature))) throw new ConflictException({ code: 'feature_disabled', feature, message: 'Recurso temporariamente indisponivel para esta empresa' });
  }
  async update(tenantId: string, updates: Partial<TenantFeatureFlags>, userId: string) {
    const next = { ...(await this.get(tenantId)), ...updates };
    await this.db.query(`INSERT INTO tenant_feature_flags (tenant_id, schedule_enforcement, callbacks, privacy_requests, onboarding, updated_by, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,now()) ON CONFLICT (tenant_id) DO UPDATE SET schedule_enforcement=EXCLUDED.schedule_enforcement, callbacks=EXCLUDED.callbacks, privacy_requests=EXCLUDED.privacy_requests, onboarding=EXCLUDED.onboarding, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [tenantId, next.schedule_enforcement, next.callbacks, next.privacy_requests, next.onboarding, userId]);
    await this.redis.client.del(this.key(tenantId)).catch(() => undefined);
    await this.audit.record({ actorUserId: userId, tenantId, action: 'tenant.feature_flags_updated', entityType: 'tenant', entityId: tenantId, metadata: { changed: Object.keys(updates) } });
    return next;
  }
}
