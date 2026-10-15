import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { EntitlementService } from '../billing/entitlement.service';
import { SdrCapacityService } from '../billing/sdr-capacity.service';
import { UsersService } from '../users/users.service';
import { OperatorKind, eligibleOperatorSql } from '../sdrs/operator';
import { CrmIntegration } from './crm-integrations.service';

const wsOrigin = () => String(process.env.PUBLIC_API_ORIGIN ?? 'http://localhost:3000').split(',')[0].trim().replace(/\/$/, '').replace(/^http/, 'ws');

/**
 * Links CRM users to ZapLiga operators. A CRM user is matched by e-mail: an existing SDR or leader
 * keeps their role; anyone else becomes an SDR of the tenant, which takes one paid seat.
 */
@Injectable()
export class IntegrationAgentsService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly auth: AuthService, private readonly entitlement: EntitlementService, private readonly capacity: SdrCapacityService, private readonly users: UsersService) {}

  async list(integration: CrmIntegration) {
    const result = await this.db.query(`
      SELECT a.external_user_id, a.sdr_id, a.user_id, a.provisioned, a.created_at, s.name, s.state, s.station_mode, s.operator_kind,
        (s.connection_instance_id IS NOT NULL) AS station_connected, u.email, tm.role AS membership_role, tm.status AS membership_status
      FROM crm_integration_agents a
      JOIN sdrs s ON s.tenant_id = a.tenant_id AND s.id = a.sdr_id
      JOIN users u ON u.id = a.user_id
      LEFT JOIN tenant_memberships tm ON tm.tenant_id = a.tenant_id AND tm.user_id = a.user_id
      WHERE a.integration_id = $1
      ORDER BY s.name`, [integration.id]);
    return { items: result.rows };
  }

  async ensure(integration: CrmIntegration, input: { externalUserId: string; email: string; name: string }) {
    const tenantId = integration.tenant_id;
    const email = input.email.trim().toLowerCase();
    const name = input.name.trim();
    const externalUserId = input.externalUserId.trim();
    await this.entitlement.assertAction(tenantId, 'write');
    // bcrypt is slow: hash outside the transaction, and only when the user may need creating. The
    // password is random and never shown -- the person signs in to the CRM, not to ZapLiga.
    const known = await this.db.query('SELECT 1 FROM users WHERE lower(email) = $1 LIMIT 1', [email]);
    const passwordHash = known.rows[0] ? null : await this.users.hashPassword(randomBytes(32).toString('base64url'));
    const linked = await this.db.transaction(async (client) => {
      await this.entitlement.acquireTenantLock(tenantId, client);
      let provisioned = false;
      let user = (await client.query('SELECT id, name, email, status, platform_role FROM users WHERE lower(email) = $1 LIMIT 1', [email])).rows[0];
      if (user && user.status !== 'active') throw new ConflictException({ code: 'user_blocked', message: 'Este usuário está bloqueado no ZapLiga' });
      if (!user) {
        user = (await client.query(`INSERT INTO users (id, name, email, password_hash, platform_role) VALUES ($1, $2, $3, $4, 'user') RETURNING id, name, email, status, platform_role`, [randomUUID(), name, email, passwordHash ?? await this.users.hashPassword(randomBytes(32).toString('base64url'))])).rows[0];
        provisioned = true;
      }
      const membership = (await client.query('SELECT role, status FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 LIMIT 1 FOR UPDATE', [tenantId, user.id])).rows[0];
      let kind: OperatorKind;
      if (membership?.status === 'active') kind = membership.role === 'leader' ? 'leader' : 'sdr';
      else if (!membership && user.platform_role === 'super_admin') kind = 'platform_admin';
      else {
        await this.capacity.assertCanAdd(tenantId, client);
        if (membership) await client.query(`UPDATE tenant_memberships SET role = 'sdr', status = 'active', updated_at = now() WHERE tenant_id = $1 AND user_id = $2`, [tenantId, user.id]);
        else await client.query(`INSERT INTO tenant_memberships (id, tenant_id, user_id, role) VALUES ($1, $2, $3, 'sdr')`, [randomUUID(), tenantId, user.id]);
        kind = 'sdr';
        provisioned = true;
      }
      let sdr = (await client.query('SELECT id, operator_kind FROM sdrs WHERE tenant_id = $1 AND user_id = $2 LIMIT 1', [tenantId, user.id])).rows[0];
      if (!sdr) {
        const operatorName = await this.uniqueOperatorName(client, tenantId, String(user.name || name));
        sdr = (await client.query('INSERT INTO sdrs (id, tenant_id, user_id, name, operator_kind) VALUES ($1, $2, $3, $4, $5) RETURNING id, operator_kind', [randomUUID(), tenantId, user.id, operatorName, kind])).rows[0];
      } else if (sdr.operator_kind !== kind) {
        await client.query('UPDATE sdrs SET operator_kind = $1 WHERE id = $2', [kind, sdr.id]);
      }
      try {
        await client.query(`INSERT INTO crm_integration_agents (integration_id, tenant_id, external_user_id, sdr_id, user_id, provisioned) VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (integration_id, external_user_id) DO UPDATE SET sdr_id = EXCLUDED.sdr_id, user_id = EXCLUDED.user_id,
            provisioned = crm_integration_agents.provisioned OR EXCLUDED.provisioned, updated_at = now()`, [integration.id, tenantId, externalUserId, sdr.id, user.id, provisioned]);
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw new ConflictException({ code: 'operator_already_linked', message: 'Este operador do ZapLiga já está vinculado a outro usuário do CRM' });
        throw error;
      }
      return { sdr_id: sdr.id as string, user_id: user.id as string, operator_kind: kind, provisioned };
    });
    await this.audit.record({ tenantId, action: 'crm_integration.agent_linked', entityType: 'sdr', entityId: linked.sdr_id, metadata: { integrationId: integration.id, provisioned: linked.provisioned, operatorKind: linked.operator_kind } });
    return { ...linked, external_user_id: externalUserId };
  }

  // Operator names are unique per tenant.
  private async uniqueOperatorName(client: { query: (text: string, params?: unknown[]) => Promise<any> }, tenantId: string, base: string) {
    const candidates = [base, `${base} (Franco)`, ...[2, 3, 4, 5].map((n) => `${base} (Franco ${n})`)];
    for (const candidate of candidates) {
      const taken = await client.query('SELECT 1 FROM sdrs WHERE tenant_id = $1 AND name = $2 LIMIT 1', [tenantId, candidate]);
      if (!taken.rows[0]) return candidate;
    }
    return `${base} (${randomBytes(3).toString('hex')})`;
  }

  /** Unlinks a CRM user; a membership the integration created is released (frees the seat). */
  async unlink(integration: CrmIntegration, sdrId: string) {
    const tenantId = integration.tenant_id;
    const result = await this.db.transaction(async (client) => {
      const link = (await client.query('DELETE FROM crm_integration_agents WHERE integration_id = $1 AND sdr_id = $2 RETURNING *', [integration.id, sdrId])).rows[0];
      if (!link) throw new NotFoundException('Agente não vinculado a esta integração');
      let released = false;
      if (link.provisioned) {
        const stillLinked = await client.query('SELECT 1 FROM crm_integration_agents WHERE tenant_id = $1 AND user_id = $2 LIMIT 1', [tenantId, link.user_id]);
        if (!stillLinked.rows[0]) {
          const updated = await client.query(`UPDATE tenant_memberships SET status = 'removed', updated_at = now() WHERE tenant_id = $1 AND user_id = $2 AND role = 'sdr' AND status = 'active' RETURNING 1`, [tenantId, link.user_id]);
          released = Boolean(updated.rows[0]);
        }
      }
      return { ok: true, sdr_id: sdrId, seat_released: released };
    });
    await this.audit.record({ tenantId, action: 'crm_integration.agent_unlinked', entityType: 'sdr', entityId: sdrId, metadata: { integrationId: integration.id, seatReleased: result.seat_released } });
    return result;
  }

  /** One-time ticket for the agent's browser to open a manual-only station socket. */
  async stationTicket(integration: CrmIntegration, sdrId: string) {
    const tenantId = integration.tenant_id;
    const link = await this.db.query(`SELECT a.user_id FROM crm_integration_agents a JOIN sdrs s ON s.tenant_id = a.tenant_id AND s.id = a.sdr_id
      WHERE a.integration_id = $1 AND a.sdr_id = $2 AND ${eligibleOperatorSql('s')} LIMIT 1`, [integration.id, sdrId]);
    if (!link.rows[0]) throw new NotFoundException('Agente não vinculado a esta integração ou sem acesso para operar');
    const ticket = await this.auth.createWebsocketTicket(link.rows[0].user_id, tenantId, true, integration.id);
    return { ticket: ticket.ticket, expires_at: ticket.expiresAt.toISOString(), ws_url: `${wsOrigin()}/ws/tenants/${encodeURIComponent(tenantId)}/sdr`, tenant_id: tenantId, sdr_id: sdrId };
  }
}
