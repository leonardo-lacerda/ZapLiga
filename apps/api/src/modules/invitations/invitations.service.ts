import { ConflictException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { MembershipRole, MembershipsService } from '../memberships/memberships.service';
import { TenantsService } from '../tenants/tenants.service';
import { UsersService } from '../users/users.service';
import { normalizeEmail } from '../users/users.utils';
import { InvitationMailer } from './invitation-mailer';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

@Injectable()
export class InvitationsService {
  private readonly invitationTtlSeconds = Math.max(300, Number(process.env.INVITATION_TTL_SECONDS ?? 172800));

  constructor(private readonly db: DatabaseService, private readonly tenants: TenantsService, private readonly users: UsersService, private readonly memberships: MembershipsService, private readonly audit: AuditService, private readonly mailer: InvitationMailer) {}

  async create(tenantId: string, invitedBy: string, email: string, role: MembershipRole) {
    const tenant = await this.tenants.requireById(tenantId);
    const normalizedEmail = normalizeEmail(email);
    const existingUser = await this.users.findByEmail(normalizedEmail);
    if (existingUser) {
      const existingMembership = await this.memberships.findForUserInTenant(existingUser.id, tenantId);
      if (existingMembership && existingMembership.status !== 'removed') throw new ConflictException('Este usuário já pertence à empresa');
    }
    const pending = await this.db.query(`SELECT id FROM invitations WHERE tenant_id = $1 AND lower(invited_email) = lower($2) AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() LIMIT 1`, [tenantId, normalizedEmail]);
    if (pending.rows[0]) throw new ConflictException('Já existe um convite pendente para este e-mail');
    const token = randomBytes(32).toString('base64url');
    const invitationId = randomUUID();
    const expiresAt = new Date(Date.now() + this.invitationTtlSeconds * 1000);
    await this.db.query(`INSERT INTO invitations (id, tenant_id, invited_email, role, token_hash, invited_by, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [invitationId, tenantId, normalizedEmail, role, hashToken(token), invitedBy, expiresAt]);
    const origin = (process.env.WEB_ORIGIN ?? 'http://localhost:5173').split(',')[0].replace(/\/$/, '');
    const invitationUrl = `${origin}/invite/${encodeURIComponent(token)}`;
    try {
      await this.mailer.send({ email: normalizedEmail, tenantName: tenant.name, role, invitationUrl });
    } catch (error) {
      await this.db.query('UPDATE invitations SET revoked_at = now() WHERE id = $1 AND accepted_at IS NULL', [invitationId]);
      throw error;
    }
    await this.audit.record({ actorUserId: invitedBy, tenantId, action: 'invitation.created', entityType: 'invitation', entityId: invitationId, metadata: { email: normalizedEmail, role } });
    return { id: invitationId, tenantId, email: normalizedEmail, role, expiresAt, invitationUrl: process.env.NODE_ENV === 'production' ? undefined : invitationUrl };
  }

  async preview(token: string) {
    const result = await this.db.query(`
      SELECT i.id, i.invited_email, i.role, i.expires_at, t.id AS tenant_id, t.name AS tenant_name, t.status AS tenant_status
      FROM invitations i JOIN tenants t ON t.id = i.tenant_id
      WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
      LIMIT 1
    `, [hashToken(token)]);
    const invitation = result.rows[0];
    if (!invitation || invitation.tenant_status !== 'active' || new Date(invitation.expires_at).getTime() <= Date.now()) throw new NotFoundException('Convite inválido, expirado ou revogado');
    return { valid: true, email: invitation.invited_email, role: invitation.role, expiresAt: invitation.expires_at, tenant: { id: invitation.tenant_id, name: invitation.tenant_name } };
  }

  async accept(token: string, name: string, password: string) {
    const tokenHash = hashToken(token);
    const passwordHash = await this.users.hashPassword(password);
    const accepted = await this.db.transaction(async (client) => {
      const result = await client.query(`
        SELECT i.*, t.name AS tenant_name, t.status AS tenant_status
        FROM invitations i JOIN tenants t ON t.id = i.tenant_id
        WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
        FOR UPDATE
      `, [tokenHash]);
      const invitation = result.rows[0];
      if (!invitation || invitation.tenant_status !== 'active' || new Date(invitation.expires_at).getTime() <= Date.now()) throw new NotFoundException('Convite inválido, expirado ou revogado');
      const existing = await client.query('SELECT * FROM users WHERE lower(email) = lower($1) LIMIT 1', [invitation.invited_email]);
      if (existing.rows[0]) throw new ConflictException('Este e-mail já possui uma conta. Faça login para receber o acesso ou peça um novo convite.');
      const userResult = await client.query(`INSERT INTO users (id, name, email, password_hash) VALUES ($1, $2, $3, $4) RETURNING *`, [randomUUID(), name.trim(), invitation.invited_email, passwordHash]);
      const user = userResult.rows[0];
      const membership = await client.query(`INSERT INTO tenant_memberships (id, tenant_id, user_id, role) VALUES ($1, $2, $3, $4) RETURNING *`, [randomUUID(), invitation.tenant_id, user.id, invitation.role]);
      await client.query('UPDATE invitations SET accepted_at = now() WHERE id = $1', [invitation.id]);
      return { user, membership: membership.rows[0], invitation };
    });
    await this.audit.record({ actorUserId: accepted.user.id, tenantId: accepted.invitation.tenant_id, action: 'invitation.accepted', entityType: 'invitation', entityId: accepted.invitation.id, metadata: { role: accepted.membership.role } });
    return accepted;
  }

  async revoke(tenantId: string, invitationId: string, actorUserId: string) {
    const result = await this.db.query(`UPDATE invitations SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id, tenant_id`, [invitationId, tenantId]);
    if (!result.rows[0]) throw new NotFoundException('Convite não encontrado ou já encerrado');
    await this.audit.record({ actorUserId, tenantId, action: 'invitation.revoked', entityType: 'invitation', entityId: invitationId });
    return { ok: true, id: invitationId };
  }

  async list(tenantId: string) {
    return (await this.db.query(`SELECT id, tenant_id, invited_email, role, expires_at, accepted_at, revoked_at, created_at FROM invitations WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId])).rows;
  }
}
