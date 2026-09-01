import { ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { MembershipRole, MembershipsService } from '../memberships/memberships.service';
import { TenantsService } from '../tenants/tenants.service';
import { UsersService } from '../users/users.service';
import { normalizeEmail } from '../users/users.utils';
import { InvitationMailer } from './invitation-mailer';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
type InvitationDelivery = 'email' | 'manual_link';

@Injectable()
export class InvitationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InvitationsService.name);
  private readonly invitationTtlSeconds = Math.max(300, Number(process.env.INVITATION_TTL_SECONDS ?? 172800));
  private deliveryTimer?: NodeJS.Timeout;

  constructor(private readonly db: DatabaseService, private readonly tenants: TenantsService, private readonly users: UsersService, private readonly memberships: MembershipsService, private readonly audit: AuditService, private readonly mailer: InvitationMailer) {}

  onModuleInit() { const run = () => void this.processDeliveryQueue().catch(() => this.logger.error('Falha ao processar fila de convites')); this.deliveryTimer = setInterval(run, 30_000); run(); }
  onModuleDestroy() { if (this.deliveryTimer) clearInterval(this.deliveryTimer); }
  private get deliverySecret() { return process.env.DATA_PROTECTION_SECRET ?? process.env.JWT_ACCESS_SECRET ?? 'development-data-protection-key'; }
  private protectToken(token: string) { const key = createHash('sha256').update(this.deliverySecret).digest(); const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]); return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`; }
  private revealToken(value: string) { const [iv, tag, body] = value.split('.'); const key = createHash('sha256').update(this.deliverySecret).digest(); const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url')); decipher.setAuthTag(Buffer.from(tag, 'base64url')); return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8'); }

  async create(tenantId: string, invitedBy: string, email: string, role: MembershipRole, inviteeName?: string, delivery: InvitationDelivery = 'email') {
    const tenant = await this.tenants.requireById(tenantId);
    const normalizedEmail = normalizeEmail(email);
    const normalizedName = inviteeName?.trim() || null;
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
    await this.db.query(`INSERT INTO invitations (id, tenant_id, invited_email, invitee_name, role, token_hash, invited_by, expires_at, delivery_token_encrypted, next_delivery_attempt_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`, [invitationId, tenantId, normalizedEmail, normalizedName, role, hashToken(token), invitedBy, expiresAt, delivery === 'email' ? this.protectToken(token) : null]);
    const origin = (process.env.WEB_ORIGIN ?? 'http://localhost:5173').split(',')[0].replace(/\/$/, '');
    const invitationUrl = `${origin}/convite/${encodeURIComponent(token)}`;
    if (delivery === 'email') await this.deliver(invitationId, { email: normalizedEmail, tenantName: tenant.name, role, invitationUrl });
    await this.audit.record({ actorUserId: invitedBy, tenantId, action: role === 'sdr' ? 'sdr.invitation.created' : 'invitation.created', entityType: 'invitation', entityId: invitationId, metadata: { role, delivery } });
    return { id: invitationId, tenantId, name: normalizedName, email: normalizedEmail, role, expiresAt, invitationUrl };
  }

  createSdrInvitation(tenantId: string, invitedBy: string, email: string, name: string) {
    return this.create(tenantId, invitedBy, email, 'sdr', name, 'email');
  }

  async resendSdrInvitation(tenantId: string, invitationId: string, invitedBy: string) {
    return this.resend(tenantId, invitationId, invitedBy);
  }

  async resend(tenantId: string, invitationId: string, invitedBy: string) {
    const result = await this.db.query(`SELECT i.*, t.name AS tenant_name FROM invitations i JOIN tenants t ON t.id = i.tenant_id WHERE i.id = $1 AND i.tenant_id = $2 AND i.accepted_at IS NULL AND i.revoked_at IS NULL LIMIT 1`, [invitationId, tenantId]);
    const invitation = result.rows[0];
    if (!invitation) throw new NotFoundException('Convite não encontrado ou já encerrado');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.invitationTtlSeconds * 1000);
    await this.db.query(`UPDATE invitations SET token_hash = $1, expires_at = $2, delivery_status = 'queued', delivery_attempts = 0, delivery_error = NULL, delivery_token_encrypted = $4, next_delivery_attempt_at = now() WHERE id = $3`, [hashToken(token), expiresAt, invitationId, this.protectToken(token)]);
    const origin = (process.env.WEB_ORIGIN ?? 'http://localhost:5173').split(',')[0].replace(/\/$/, '');
    const invitationUrl = `${origin}/convite/${encodeURIComponent(token)}`;
    await this.deliver(invitationId, { email: invitation.invited_email, tenantName: invitation.tenant_name, role: invitation.role, invitationUrl });
    await this.audit.record({ actorUserId: invitedBy, tenantId, action: 'invitation.resent', entityType: 'invitation', entityId: invitationId });
    return { id: invitationId, tenantId, email: invitation.invited_email, role: invitation.role, expiresAt, invitationUrl };
  }

  async preview(token: string) {
    const result = await this.db.query(`
      SELECT i.id, i.invited_email, i.invitee_name, i.role, i.expires_at, t.id AS tenant_id, t.name AS tenant_name, t.status AS tenant_status
      FROM invitations i JOIN tenants t ON t.id = i.tenant_id
      WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
      LIMIT 1
    `, [hashToken(token)]);
    const invitation = result.rows[0];
    if (!invitation || invitation.tenant_status !== 'active' || new Date(invitation.expires_at).getTime() <= Date.now()) throw new NotFoundException('Convite inválido, expirado ou revogado');
    await this.db.query('UPDATE invitations SET opened_at = COALESCE(opened_at, now()) WHERE id = $1', [invitation.id]);
    return { valid: true, name: invitation.invitee_name, email: invitation.invited_email, role: invitation.role, expiresAt: invitation.expires_at, tenant: { id: invitation.tenant_id, name: invitation.tenant_name } };
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
      if (existing.rows[0] && !(await this.users.comparePassword(password, existing.rows[0].password_hash))) throw new ConflictException('A senha da conta existente está incorreta');
      const user = existing.rows[0] ?? (await client.query(`INSERT INTO users (id, name, email, password_hash, email_verified_at) VALUES ($1, $2, $3, $4, now()) RETURNING *`, [randomUUID(), name.trim(), invitation.invited_email, passwordHash])).rows[0];
      const existingMembership = await client.query('SELECT * FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 LIMIT 1 FOR UPDATE', [invitation.tenant_id, user.id]);
      let membership;
      if (existingMembership.rows[0]) {
        if (existingMembership.rows[0].status !== 'removed') throw new ConflictException('Este usuário já pertence à empresa');
        membership = await client.query('UPDATE tenant_memberships SET role = $1, status = \'active\', updated_at = now() WHERE tenant_id = $2 AND user_id = $3 RETURNING *', [invitation.role, invitation.tenant_id, user.id]);
      } else {
        membership = await client.query(`INSERT INTO tenant_memberships (id, tenant_id, user_id, role) VALUES ($1, $2, $3, $4) RETURNING *`, [randomUUID(), invitation.tenant_id, user.id, invitation.role]);
      }
      if (invitation.role === 'sdr') {
        await client.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [invitation.tenant_id]);
        const quota = await client.query(`
          SELECT t.max_sdrs, count(tm.user_id)::int AS current
          FROM tenants t LEFT JOIN sdrs s ON s.tenant_id = t.id
            LEFT JOIN tenant_memberships tm ON tm.tenant_id = s.tenant_id AND tm.user_id = s.user_id AND tm.role = 'sdr' AND tm.status = 'active'
          WHERE t.id = $1
          GROUP BY t.id, t.max_sdrs
        `, [invitation.tenant_id]);
        if (Number(quota.rows[0]?.current ?? 0) >= Number(quota.rows[0]?.max_sdrs ?? 500)) throw new ConflictException('O limite de SDRs desta empresa foi atingido');
        await client.query('INSERT INTO sdrs (id, tenant_id, user_id, name) VALUES ($1, $2, $3, $4)', [randomUUID(), invitation.tenant_id, user.id, user.name]);
      }
      await client.query('UPDATE invitations SET accepted_at = now(), delivery_token_encrypted = NULL, next_delivery_attempt_at = NULL WHERE id = $1', [invitation.id]);
      return { user, membership: membership.rows[0], invitation };
    });
    await this.audit.record({ actorUserId: accepted.user.id, tenantId: accepted.invitation.tenant_id, action: accepted.membership.role === 'sdr' ? 'sdr.invitation.accepted' : 'invitation.accepted', entityType: 'invitation', entityId: accepted.invitation.id, metadata: { role: accepted.membership.role } });
    return accepted;
  }

  async revoke(tenantId: string, invitationId: string, actorUserId: string) {
    const result = await this.db.query(`UPDATE invitations SET revoked_at = now(), delivery_token_encrypted = NULL, next_delivery_attempt_at = NULL WHERE id = $1 AND tenant_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id, tenant_id, role`, [invitationId, tenantId]);
    if (!result.rows[0]) throw new NotFoundException('Convite não encontrado ou já encerrado');
    await this.audit.record({ actorUserId, tenantId, action: result.rows[0].role === 'sdr' ? 'sdr.invitation.revoked' : 'invitation.revoked', entityType: 'invitation', entityId: invitationId });
    return { ok: true, id: invitationId };
  }

  async list(tenantId: string, role?: MembershipRole, limit = 100, offset = 0) {
    const safeLimit = Math.min(500, Math.max(1, Math.floor(Number(limit) || 100)));
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const values: unknown[] = [tenantId];
    let roleClause = '';
    if (role) { values.push(role); roleClause = `AND role = $${values.length}`; }
    const total = await this.db.query(`SELECT count(*)::int AS total FROM invitations WHERE tenant_id = $1 ${roleClause}`, values);
    values.push(safeLimit, safeOffset);
    const items = await this.db.query(`
      SELECT id, tenant_id, invited_email, invitee_name, role, expires_at, accepted_at, revoked_at, created_at,
        delivery_status, delivery_attempts, delivery_error, sent_at, opened_at,
        CASE WHEN accepted_at IS NOT NULL THEN 'accepted' WHEN revoked_at IS NOT NULL THEN 'revoked'
          WHEN expires_at <= now() THEN 'expired' WHEN opened_at IS NOT NULL THEN 'opened' ELSE delivery_status END AS display_status
      FROM invitations
      WHERE tenant_id = $1 ${roleClause}
      ORDER BY created_at DESC
      LIMIT $${values.length - 1} OFFSET $${values.length}
    `, values);
    return { items: items.rows, total: Number(total.rows[0]?.total ?? 0), limit: safeLimit, offset: safeOffset };
  }

  private async deliver(invitationId: string, message: { email: string; tenantName: string; role: string; invitationUrl: string }) {
    try {
      await this.mailer.send(message);
      await this.db.query(`UPDATE invitations SET delivery_status = 'sent', delivery_attempts = delivery_attempts + 1, delivery_error = NULL, sent_at = now(), next_delivery_attempt_at = NULL, delivery_token_encrypted = NULL WHERE id = $1`, [invitationId]);
      return true;
    } catch (error) {
      const failure = String((error as Error).message ?? error).slice(0, 1000);
      await this.db.query(`UPDATE invitations SET delivery_attempts = delivery_attempts + 1,
        delivery_status = CASE WHEN delivery_attempts + 1 >= 3 THEN 'failed' ELSE 'queued' END,
        delivery_error = $2,
        next_delivery_attempt_at = CASE WHEN delivery_attempts + 1 >= 3 THEN NULL ELSE now() + (power(4, delivery_attempts) * interval '1 minute') END,
        delivery_token_encrypted = CASE WHEN delivery_attempts + 1 >= 3 THEN NULL ELSE delivery_token_encrypted END
        WHERE id = $1`, [invitationId, failure]);
      return false;
    }
  }

  private async processDeliveryQueue() {
    const claimed = await this.db.query(`UPDATE invitations SET next_delivery_attempt_at = now() + interval '5 minutes'
      WHERE id IN (SELECT id FROM invitations WHERE delivery_status = 'queued' AND delivery_token_encrypted IS NOT NULL AND next_delivery_attempt_at <= now() AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY next_delivery_attempt_at FOR UPDATE SKIP LOCKED LIMIT 20)
      RETURNING id, invited_email, role, delivery_token_encrypted, (SELECT name FROM tenants WHERE id = invitations.tenant_id) AS tenant_name`);
    const origin = (process.env.WEB_ORIGIN ?? 'http://localhost:5173').split(',')[0].replace(/\/$/, '');
    for (const row of claimed.rows) {
      try {
        const token = this.revealToken(row.delivery_token_encrypted);
        await this.deliver(row.id, { email: row.invited_email, tenantName: row.tenant_name, role: row.role, invitationUrl: `${origin}/convite/${encodeURIComponent(token)}` });
      } catch {
        await this.db.query(`UPDATE invitations SET delivery_status = 'failed', delivery_error = 'delivery_payload_unavailable', next_delivery_attempt_at = NULL, delivery_token_encrypted = NULL WHERE id = $1`, [row.id]);
      }
    }
  }
}
