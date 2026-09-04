import { ConflictException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { AuditService } from '../audit/audit.service';

export const TENANT_FEATURES = [
  'schedule_enforcement',
  'callbacks',
  'privacy_requests',
  'onboarding',
  'campaigns',
  'decision_engine',
  'recommendations',
  'operation_health',
  'analytics_learning',
  'experiments',
  'benchmarks',
] as const;
export type TenantFeature = typeof TENANT_FEATURES[number];
export type TenantFeatureFlags = Record<TenantFeature, boolean>;
export const defaultTenantFeatureFlags = (): TenantFeatureFlags => ({
  schedule_enforcement: false,
  callbacks: false,
  privacy_requests: false,
  onboarding: false,
  campaigns: false,
  decision_engine: false,
  recommendations: false,
  operation_health: false,
  analytics_learning: false,
  experiments: false,
  benchmarks: false,
});

@Injectable()
export class FeatureFlagsService {
  constructor(private readonly db: DatabaseService, private readonly redis: RedisService, private readonly audit: AuditService) {}
  private key(tenantId: string) { return `zapcall:tenant:${tenantId}:feature-flags`; }
  async get(tenantId: string): Promise<TenantFeatureFlags> {
    const cached = await this.redis.client.get(this.key(tenantId)).catch(() => null);
    if (cached) { try { return { ...defaultTenantFeatureFlags(), ...JSON.parse(cached) }; } catch { await this.redis.client.del(this.key(tenantId)).catch(() => undefined); } }
    const row = (await this.db.query(`SELECT ${TENANT_FEATURES.join(', ')} FROM tenant_feature_flags WHERE tenant_id = $1`, [tenantId])).rows[0];
    const flags = { ...defaultTenantFeatureFlags(), ...(row ?? {}) };
    await this.redis.client.set(this.key(tenantId), JSON.stringify(flags), 'EX', 60).catch(() => undefined);
    return flags;
  }
  async enabled(tenantId: string, feature: TenantFeature) { return (await this.get(tenantId))[feature]; }
  async assertEnabled(tenantId: string, feature: TenantFeature) {
    if (!(await this.enabled(tenantId, feature))) throw new ConflictException({ code: 'feature_disabled', feature, message: 'Recurso temporariamente indisponivel para esta empresa' });
  }
  async update(tenantId: string, updates: Partial<TenantFeatureFlags>, userId: string) {
    const definedUpdates = Object.fromEntries(
      TENANT_FEATURES
        .filter((feature) => typeof updates[feature] === 'boolean')
        .map((feature) => [feature, updates[feature]]),
    ) as Partial<TenantFeatureFlags>;
    const next = { ...(await this.get(tenantId)), ...definedUpdates };
    const columns = TENANT_FEATURES.join(', ');
    const values = TENANT_FEATURES.map((_, index) => `$${index + 2}`).join(', ');
    const assignments = TENANT_FEATURES.map((feature) => `${feature}=EXCLUDED.${feature}`).join(', ');
    await this.db.query(`INSERT INTO tenant_feature_flags (tenant_id, ${columns}, updated_by, updated_at)
      VALUES ($1, ${values}, $${TENANT_FEATURES.length + 2}, now())
      ON CONFLICT (tenant_id) DO UPDATE SET ${assignments}, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [tenantId, ...TENANT_FEATURES.map((feature) => next[feature]), userId]);
    await this.redis.client.del(this.key(tenantId)).catch(() => undefined);
    await this.audit.record({ actorUserId: userId, tenantId, action: 'tenant.feature_flags_updated', entityType: 'tenant', entityId: tenantId, metadata: { changed: Object.keys(definedUpdates) } });
    return next;
  }
}
