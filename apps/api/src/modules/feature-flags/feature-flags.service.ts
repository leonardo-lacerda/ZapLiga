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
  'lead_ingestion_api',
  'advanced_reports',
] as const;
export type TenantFeature = typeof TENANT_FEATURES[number];
export type TenantFeatureFlags = Record<TenantFeature, boolean>;
export type FeatureLevel = 'none' | 'read_only' | 'basic' | 'full';
export type TenantFeatureEntitlements = Record<TenantFeature, FeatureLevel>;
const FEATURE_FLAGS_CACHE_MAX_BYTES = 4 * 1024;
export const defaultTenantFeatureFlags = (): TenantFeatureFlags => ({
  // Launch features stay on by default; super admin can still disable per tenant.
  schedule_enforcement: true,
  callbacks: true,
  privacy_requests: true,
  onboarding: true,
  // Roadmap capabilities remain opt-in until each rollout gate.
  campaigns: false,
  decision_engine: false,
  recommendations: false,
  operation_health: false,
  analytics_learning: false,
  experiments: false,
  benchmarks: false,
  lead_ingestion_api: false,
  advanced_reports: false,
});

const normalizeFeatureFlags = (value: unknown): TenantFeatureFlags => {
  const flags = defaultTenantFeatureFlags();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return flags;
  const source = value as Record<string, unknown>;
  for (const feature of TENANT_FEATURES) {
    if (typeof source[feature] === 'boolean') flags[feature] = source[feature];
  }
  return flags;
};

const normalizeLevels = (value: unknown): Partial<TenantFeatureEntitlements> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: Partial<TenantFeatureEntitlements> = {};
  for (const feature of TENANT_FEATURES) {
    const level = source[feature];
    if (level === 'none' || level === 'read_only' || level === 'basic' || level === 'full') result[feature] = level;
    else if (level === true) result[feature] = 'full';
  }
  return result;
};

@Injectable()
export class FeatureFlagsService {
  constructor(private readonly db: DatabaseService, private readonly redis: RedisService, private readonly audit: AuditService) {}
  private key(tenantId: string) { return `zapcall:tenant:${tenantId}:feature-flags`; }
  async get(tenantId: string): Promise<TenantFeatureFlags> {
    const cached = await this.redis.client.get(this.key(tenantId)).catch(() => null);
    if (cached && Buffer.byteLength(cached, 'utf8') <= FEATURE_FLAGS_CACHE_MAX_BYTES) {
      try {
        const parsed = JSON.parse(cached);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return normalizeFeatureFlags(parsed);
      } catch { /* descarta o cache inválido abaixo */ }
    }
    if (cached) await this.redis.client.del(this.key(tenantId)).catch(() => undefined);
    const row = (await this.db.query(`
      SELECT tff.${TENANT_FEATURES.join(', tff.')},
        e.access_mode, e.feature_entitlements, e.last_active_feature_entitlements,
        c.operational_flags
      FROM tenants t
      LEFT JOIN tenant_feature_flags tff ON tff.tenant_id = t.id
      LEFT JOIN tenant_entitlements e ON e.tenant_id = t.id
      LEFT JOIN tenant_feature_controls c ON c.tenant_id = t.id
      WHERE t.id = $1
    `, [tenantId])).rows[0];
    const legacy = normalizeFeatureFlags(row);
    const active = normalizeLevels(row?.feature_entitlements);
    const historical = normalizeLevels(row?.last_active_feature_entitlements);
    const operational = row?.operational_flags && typeof row.operational_flags === 'object' ? row.operational_flags as Record<string, unknown> : {};
    const hasCommercialSnapshot = row?.feature_entitlements && typeof row.feature_entitlements === 'object' && !Array.isArray(row.feature_entitlements);
    const flags = { ...legacy };
    for (const feature of TENANT_FEATURES) {
      const level = row?.access_mode === 'full' && hasCommercialSnapshot
        ? (active[feature] ?? 'none')
        : (active[feature] ?? historical[feature]);
      if (level) flags[feature] = level !== 'none';
      if (operational[feature] === false) flags[feature] = false;
    }
    await this.redis.client.set(this.key(tenantId), JSON.stringify(flags), 'EX', 60).catch(() => undefined);
    return flags;
  }
  async enabled(tenantId: string, feature: TenantFeature) { return (await this.get(tenantId))[feature]; }
  async getEffective(tenantId: string) {
    return { flags: await this.get(tenantId), levels: await this.getLevels(tenantId) };
  }
  async getLevels(tenantId: string): Promise<TenantFeatureEntitlements> {
    const result = await this.db.query(`
      SELECT e.access_mode, e.access_until, e.feature_entitlements, e.last_active_feature_entitlements,
        c.operational_flags
      FROM tenants t
      LEFT JOIN tenant_entitlements e ON e.tenant_id = t.id
      LEFT JOIN tenant_feature_controls c ON c.tenant_id = t.id
      WHERE t.id = $1
    `, [tenantId]);
    const row = result.rows[0] ?? {};
    const overrideResult = await this.db.query(`SELECT feature_code, override_mode, value FROM tenant_entitlement_overrides WHERE tenant_id = $1 AND revoked_at IS NULL AND starts_at <= now() AND (expires_at IS NULL OR expires_at > now())`, [tenantId]);
    const active = normalizeLevels(row.feature_entitlements);
    const historical = normalizeLevels(row.last_active_feature_entitlements);
    for (const override of overrideResult.rows) {
      if (!override.feature_code) continue;
      if (override.override_mode === 'deny') active[String(override.feature_code) as TenantFeature] = 'none';
      if (override.override_mode === 'grant') active[String(override.feature_code) as TenantFeature] = (override.value?.level ?? 'full') as FeatureLevel;
    }
    const operational = row.operational_flags && typeof row.operational_flags === 'object' ? row.operational_flags as Record<string, unknown> : {};
    const fullyEntitled = row.access_mode === 'full' && (!row.access_until || new Date(row.access_until).getTime() > Date.now());
    const hasCommercialSnapshot = row.feature_entitlements && typeof row.feature_entitlements === 'object' && !Array.isArray(row.feature_entitlements);
    const levels = {} as TenantFeatureEntitlements;
    for (const feature of TENANT_FEATURES) {
      const configured = active[feature] ?? historical[feature] ?? (fullyEntitled && hasCommercialSnapshot ? 'none' : (normalizeFeatureFlags(row)[feature] ? 'full' : 'none'));
      levels[feature] = operational[feature] === false ? 'none' : (fullyEntitled ? configured : (configured === 'none' ? 'none' : 'read_only'));
    }
    return levels;
  }
  async assertEnabled(tenantId: string, feature: TenantFeature, method = 'GET') {
    const level = (await this.getLevels(tenantId))[feature];
    const read = method.toUpperCase() === 'GET' || method.toUpperCase() === 'HEAD' || method.toUpperCase() === 'OPTIONS';
    if (level === 'none' || (level === 'read_only' && !read)) {
      throw new ConflictException({ code: 'feature_disabled', feature, level, message: level === 'read_only' ? 'Este recurso está disponível apenas para consulta.' : 'Recurso indisponível para esta empresa' });
    }
  }
  async update(tenantId: string, updates: Partial<TenantFeatureFlags>, userId: string) {
    // The DTO declares every flag as an optional field, so an unset flag still
    // arrives here as an own property with value `undefined` (not absent) —
    // spreading it over the current flags would null out that column.
    const definedUpdates = Object.fromEntries(
      TENANT_FEATURES
        .filter((feature) => typeof updates[feature] === 'boolean')
        .map((feature) => [feature, updates[feature]]),
    ) as Partial<TenantFeatureFlags>;
    const current = await this.get(tenantId);
    const next = { ...current, ...definedUpdates };
    // Keep the legacy projection populated for older workers and migration
    // tooling. It is no longer the source of commercial plan activation.
    const columns = TENANT_FEATURES.join(', ');
    const values = TENANT_FEATURES.map((_, index) => `$${index + 2}`).join(', ');
    const assignments = TENANT_FEATURES.map((feature) => `${feature}=EXCLUDED.${feature}`).join(', ');
    await this.db.query(`INSERT INTO tenant_feature_flags (tenant_id, ${columns}, updated_by, updated_at)
      VALUES ($1, ${values}, $${TENANT_FEATURES.length + 2}, now())
      ON CONFLICT (tenant_id) DO UPDATE SET ${assignments}, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [tenantId, ...TENANT_FEATURES.map((feature) => next[feature]), userId]);
    await this.db.query(`INSERT INTO tenant_feature_controls (tenant_id, operational_flags, updated_by, updated_at)
      VALUES ($1, $2::jsonb, $3, now())
      ON CONFLICT (tenant_id) DO UPDATE SET operational_flags = tenant_feature_controls.operational_flags || EXCLUDED.operational_flags, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [tenantId, JSON.stringify(definedUpdates), userId]);
    await this.redis.client.del(this.key(tenantId)).catch(() => undefined);
    await this.audit.record({ actorUserId: userId, tenantId, action: 'tenant.feature_flags_updated', entityType: 'tenant', entityId: tenantId, metadata: { changed: Object.keys(definedUpdates) } });
    return next;
  }
}
