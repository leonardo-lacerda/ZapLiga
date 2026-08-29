import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../infrastructure/redis/redis.service';

type ListFilters = { search?: string; status?: string; role?: string; tenantId?: string; limit?: number; offset?: number };

const page = (limit?: number, offset?: number) => ({
  limit: Math.min(200, Math.max(1, Math.floor(Number(limit) || 50))),
  offset: Math.max(0, Math.floor(Number(offset) || 0)),
});

@Injectable()
export class AdminService {
  constructor(private readonly db: DatabaseService, private readonly redis: RedisService) {}

  async overview(tenantId?: string) {
    const scope = tenantId?.trim() || null;
    const [metrics, statusRows, recentTenants] = await Promise.all([
      this.db.query(`
        SELECT
          (SELECT count(*)::int FROM tenants WHERE ($1::text IS NULL OR id = $1)) AS tenants_total,
          (SELECT count(*)::int FROM tenants WHERE status = 'active' AND ($1::text IS NULL OR id = $1)) AS tenants_active,
          (SELECT count(*)::int FROM users u WHERE u.status = 'active' AND ($1::text IS NULL OR EXISTS (SELECT 1 FROM tenant_memberships tm WHERE tm.user_id = u.id AND tm.tenant_id = $1 AND tm.status <> 'removed'))) AS users_active,
          (SELECT count(*)::int FROM calls WHERE created_at >= date_trunc('day', now()) AND ($1::text IS NULL OR tenant_id = $1)) AS calls_today,
          (SELECT count(*)::int FROM calls WHERE status IN ('reserved','dialing','media_active') AND ($1::text IS NULL OR tenant_id = $1)) AS active_calls,
          (SELECT count(*)::int FROM calls WHERE status = 'failed' AND created_at >= date_trunc('day', now()) AND ($1::text IS NULL OR tenant_id = $1)) AS failed_calls_today,
          (SELECT count(*)::int FROM leads WHERE status IN ('queued','retry_wait') AND do_not_call = false AND ($1::text IS NULL OR tenant_id = $1)) AS queued_leads,
          (SELECT count(*)::int FROM sdrs WHERE available = true AND state = 'available' AND ($1::text IS NULL OR tenant_id = $1)) AS available_sdrs,
          (SELECT count(*)::int FROM whatsapp_numbers WHERE status IN ('connected','online','ready','authenticated') AND ($1::text IS NULL OR tenant_id = $1)) AS connected_numbers,
          (SELECT count(*)::int FROM whatsapp_numbers WHERE status NOT IN ('connected','online','ready','authenticated','removed') AND ($1::text IS NULL OR tenant_id = $1)) AS disconnected_numbers
      `, [scope]),
      this.db.query(`SELECT status, count(*)::int AS count FROM tenants WHERE ($1::text IS NULL OR id = $1) GROUP BY status ORDER BY status`, [scope]),
      this.db.query(`
        SELECT t.id, t.name, t.slug, t.status, t.updated_at,
          (SELECT count(*)::int FROM calls c WHERE c.tenant_id = t.id AND c.created_at >= date_trunc('day', now())) AS calls_today,
          (SELECT count(*)::int FROM calls c WHERE c.tenant_id = t.id AND c.status = 'failed' AND c.created_at >= date_trunc('day', now())) AS failures_today,
          (SELECT count(*)::int FROM leads l WHERE l.tenant_id = t.id AND l.status IN ('queued','retry_wait') AND l.do_not_call = false) AS queued_leads,
          COALESCE((SELECT running FROM dialer_settings d WHERE d.tenant_id = t.id), false) AS dialer_running
        FROM tenants t
        WHERE ($1::text IS NULL OR t.id = $1)
        ORDER BY failures_today DESC, calls_today DESC, t.created_at DESC
        LIMIT 8
      `, [scope]),
    ]);
    return { metrics: metrics.rows[0], tenantStatus: statusRows.rows, attention: recentTenants.rows, generatedAt: new Date().toISOString() };
  }

  async listTenants(filters: ListFilters = {}) {
    const pagination = page(filters.limit, filters.offset);
    const values: unknown[] = [];
    const where: string[] = [];
    if (filters.search?.trim()) { values.push(`%${filters.search.trim()}%`); where.push(`(t.name ILIKE $${values.length} OR t.slug ILIKE $${values.length})`); }
    if (['active', 'blocked', 'archived'].includes(String(filters.status))) { values.push(filters.status); where.push(`t.status = $${values.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countValues = [...values];
    const total = await this.db.query(`SELECT count(*)::int AS total FROM tenants t ${clause}`, countValues);
    values.push(pagination.limit, pagination.offset);
    const items = await this.db.query(`
      SELECT t.*,
        (SELECT count(*)::int FROM tenant_memberships tm WHERE tm.tenant_id = t.id AND tm.status <> 'removed') AS member_count,
        (SELECT count(*)::int FROM leads l WHERE l.tenant_id = t.id) AS lead_count,
        (SELECT count(*)::int FROM sdrs s WHERE s.tenant_id = t.id) AS sdr_count,
        (SELECT count(*)::int FROM whatsapp_numbers n WHERE n.tenant_id = t.id AND n.status <> 'removed') AS number_count,
        (SELECT count(*)::int FROM whatsapp_numbers n WHERE n.tenant_id = t.id AND n.status IN ('connected','online','ready','authenticated')) AS connected_numbers,
        (SELECT count(*)::int FROM calls c WHERE c.tenant_id = t.id AND c.created_at >= date_trunc('day', now())) AS calls_today,
        COALESCE((SELECT running FROM dialer_settings d WHERE d.tenant_id = t.id), false) AS dialer_running
      FROM tenants t ${clause}
      ORDER BY t.created_at DESC
      LIMIT $${values.length - 1} OFFSET $${values.length}
    `, values);
    return { items: items.rows, total: Number(total.rows[0]?.total ?? 0), ...pagination };
  }

  async tenantSummary(tenantId: string) {
    const [tenant, members, invitations, calls] = await Promise.all([
      this.db.query(`
        SELECT t.*,
          (SELECT count(*)::int FROM leads l WHERE l.tenant_id = t.id) AS lead_count,
          (SELECT count(*)::int FROM leads l WHERE l.tenant_id = t.id AND l.status IN ('queued','retry_wait') AND l.do_not_call = false) AS queued_leads,
          (SELECT count(*)::int FROM sdrs s WHERE s.tenant_id = t.id) AS sdr_count,
          (SELECT count(*)::int FROM sdrs s WHERE s.tenant_id = t.id AND s.available = true) AS available_sdrs,
          (SELECT count(*)::int FROM whatsapp_numbers n WHERE n.tenant_id = t.id AND n.status <> 'removed') AS number_count,
          (SELECT count(*)::int FROM whatsapp_numbers n WHERE n.tenant_id = t.id AND n.status IN ('connected','online','ready','authenticated')) AS connected_numbers,
          (SELECT count(*)::int FROM calls c WHERE c.tenant_id = t.id AND c.created_at >= date_trunc('day', now())) AS calls_today,
          (SELECT count(*)::int FROM calls c WHERE c.tenant_id = t.id AND c.status IN ('reserved','dialing','media_active')) AS active_calls,
          row_to_json(ds) AS dialer_settings
        FROM tenants t LEFT JOIN dialer_settings ds ON ds.tenant_id = t.id
        WHERE t.id = $1 GROUP BY t.id, ds.*
      `, [tenantId]),
      this.db.query(`SELECT tm.user_id, tm.role, tm.status, u.name, u.email, u.status AS user_status, u.last_login_at FROM tenant_memberships tm JOIN users u ON u.id = tm.user_id WHERE tm.tenant_id = $1 AND tm.status <> 'removed' ORDER BY tm.role, u.name LIMIT 100`, [tenantId]),
      this.db.query(`SELECT id, invited_email, invitee_name, role, expires_at, created_at FROM invitations WHERE tenant_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 50`, [tenantId]),
      this.db.query(`SELECT c.id, c.status, c.created_at, c.duration_seconds, l.name AS lead_name, s.name AS sdr_name, n.label AS number_label FROM calls c JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id JOIN sdrs s ON s.tenant_id = c.tenant_id AND s.id = c.sdr_id JOIN whatsapp_numbers n ON n.id = c.number_id WHERE c.tenant_id = $1 ORDER BY c.created_at DESC LIMIT 20`, [tenantId]),
    ]);
    if (!tenant.rows[0]) throw new NotFoundException('Empresa não encontrada');
    return { tenant: tenant.rows[0], members: members.rows, invitations: invitations.rows, recentCalls: calls.rows };
  }

  async listUsers(filters: ListFilters = {}) {
    const pagination = page(filters.limit, filters.offset);
    const values: unknown[] = [];
    const where: string[] = [];
    if (filters.search?.trim()) { values.push(`%${filters.search.trim()}%`); where.push(`(u.name ILIKE $${values.length} OR u.email ILIKE $${values.length})`); }
    if (['active', 'blocked'].includes(String(filters.status))) { values.push(filters.status); where.push(`u.status = $${values.length}`); }
    if (['user', 'super_admin'].includes(String(filters.role))) { values.push(filters.role); where.push(`u.platform_role = $${values.length}`); }
    if (filters.tenantId?.trim()) { values.push(filters.tenantId.trim()); where.push(`EXISTS (SELECT 1 FROM tenant_memberships scoped WHERE scoped.user_id = u.id AND scoped.tenant_id = $${values.length} AND scoped.status <> 'removed')`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.db.query(`SELECT count(*)::int AS total FROM users u ${clause}`, [...values]);
    values.push(pagination.limit, pagination.offset);
    const items = await this.db.query(`
      SELECT u.id, u.name, u.email, u.platform_role, u.status, u.created_at, u.last_login_at,
        (SELECT count(*)::int FROM user_sessions us WHERE us.user_id = u.id AND us.revoked_at IS NULL AND us.expires_at > now()) AS active_sessions,
        COALESCE((SELECT json_agg(json_build_object('tenantId', tm.tenant_id, 'tenantName', t.name, 'role', tm.role, 'status', tm.status) ORDER BY t.name) FROM tenant_memberships tm JOIN tenants t ON t.id = tm.tenant_id WHERE tm.user_id = u.id AND tm.status <> 'removed'), '[]'::json) AS memberships
      FROM users u ${clause}
      ORDER BY u.created_at DESC
      LIMIT $${values.length - 1} OFFSET $${values.length}
    `, values);
    return { items: items.rows, total: Number(total.rows[0]?.total ?? 0), ...pagination };
  }

  async operations(tenantId?: string) {
    const scope = tenantId?.trim() || null;
    const [tenants, calls, numbers, sdrs] = await Promise.all([
      this.db.query(`
        SELECT t.id, t.name, t.status,
          COALESCE((SELECT running FROM dialer_settings ds WHERE ds.tenant_id = t.id), false) AS dialer_running,
          (SELECT count(*)::int FROM calls c WHERE c.tenant_id = t.id AND c.status IN ('reserved','dialing','media_active')) AS active_calls,
          (SELECT count(*)::int FROM leads l WHERE l.tenant_id = t.id AND l.status IN ('queued','retry_wait') AND l.do_not_call = false) AS queued_leads,
          (SELECT count(*)::int FROM sdrs s WHERE s.tenant_id = t.id AND s.available = true AND s.state = 'available') AS available_sdrs,
          (SELECT count(*)::int FROM whatsapp_numbers n WHERE n.tenant_id = t.id AND n.status IN ('connected','online','ready','authenticated')) AS connected_numbers
        FROM tenants t
        WHERE ($1::text IS NULL OR t.id = $1)
        ORDER BY active_calls DESC, queued_leads DESC, t.name LIMIT 100
      `, [scope]),
      this.db.query(`SELECT c.id, c.tenant_id, t.name AS tenant_name, c.status, c.created_at, c.duration_seconds, l.name AS lead_name, s.name AS sdr_name, n.label AS number_label FROM calls c JOIN tenants t ON t.id = c.tenant_id JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id JOIN sdrs s ON s.tenant_id = c.tenant_id AND s.id = c.sdr_id JOIN whatsapp_numbers n ON n.id = c.number_id WHERE ($1::text IS NULL OR c.tenant_id = $1) ORDER BY c.created_at DESC LIMIT 30`, [scope]),
      this.db.query(`SELECT n.id, n.tenant_id, COALESCE(t.name, 'Sem organização') AS tenant_name, n.label, n.phone, n.status, n.max_concurrent_calls, n.cooldown_seconds FROM whatsapp_numbers n LEFT JOIN tenants t ON t.id = n.tenant_id WHERE n.status <> 'removed' AND ($1::text IS NULL OR n.tenant_id = $1) ORDER BY CASE WHEN n.status IN ('connected','online','ready','authenticated') THEN 1 ELSE 0 END, n.created_at DESC LIMIT 50`, [scope]),
      this.db.query(`SELECT s.id, s.tenant_id, t.name AS tenant_name, s.name, s.available, s.state, s.last_assigned_at FROM sdrs s JOIN tenants t ON t.id = s.tenant_id WHERE ($1::text IS NULL OR s.tenant_id = $1) ORDER BY CASE s.state WHEN 'in_call' THEN 0 WHEN 'post_call' THEN 1 WHEN 'available' THEN 2 ELSE 3 END, s.name LIMIT 50`, [scope]),
    ]);
    return { tenants: tenants.rows, recentCalls: calls.rows, numbers: numbers.rows, sdrs: sdrs.rows, generatedAt: new Date().toISOString() };
  }

  async health() {
    const started = Date.now();
    const [database, redis, migrations, numberStatus] = await Promise.allSettled([
      this.db.query('SELECT now() AS checked_at'),
      this.redis.client.ping(),
      this.db.query('SELECT version, applied_at FROM schema_migrations ORDER BY applied_at DESC LIMIT 1'),
      this.db.query(`SELECT status, count(*)::int AS count FROM whatsapp_numbers WHERE status <> 'removed' GROUP BY status ORDER BY status`),
    ]);
    const service = (result: PromiseSettledResult<unknown>) => result.status === 'fulfilled' ? { ok: true } : { ok: false, error: String(result.reason instanceof Error ? result.reason.message : result.reason) };
    return {
      ok: database.status === 'fulfilled' && redis.status === 'fulfilled',
      checkedAt: new Date().toISOString(),
      responseTimeMs: Date.now() - started,
      uptimeSeconds: Math.floor(process.uptime()),
      environment: process.env.NODE_ENV ?? 'development',
      services: {
        api: { ok: true },
        database: service(database),
        redis: service(redis),
        waxum: { configured: Boolean(process.env.WAXUM_URL), url: process.env.WAXUM_URL ? 'configurado' : 'padrão local', numberStatus: numberStatus.status === 'fulfilled' ? numberStatus.value.rows : [] },
      },
      latestMigration: migrations.status === 'fulfilled' ? migrations.value.rows[0] ?? null : null,
    };
  }

  async revokeUserSessions(userId: string) {
    const user = await this.db.query('SELECT id FROM users WHERE id = $1', [userId]);
    if (!user.rows[0]) throw new NotFoundException('Usuário não encontrado');
    const result = await this.db.query('UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1 AND revoked_at IS NULL RETURNING id', [userId]);
    return { ok: true, revoked: result.rowCount ?? 0 };
  }

  async revokeTenantSessions(tenantId: string) {
    const tenant = await this.db.query('SELECT id FROM tenants WHERE id = $1', [tenantId]);
    if (!tenant.rows[0]) throw new NotFoundException('Empresa não encontrada');
    const result = await this.db.query(`UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE revoked_at IS NULL AND user_id IN (SELECT user_id FROM tenant_memberships WHERE tenant_id = $1 AND status <> 'removed') RETURNING id`, [tenantId]);
    return { ok: true, revoked: result.rowCount ?? 0 };
  }
}
