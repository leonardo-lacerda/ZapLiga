import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, NotFoundException, Optional, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { Request, Response } from 'express';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { UsersService } from '../users/users.service';
import { publicUser, normalizeEmail } from '../users/users.utils';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { slugifyTenant } from '../tenants/tenants.service';
import { AccountMailer } from './account-mailer';
import { EntitlementService } from '../billing/entitlement.service';

export const REFRESH_COOKIE = 'zapcall_refresh';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const requestMeta = (request?: Request) => ({ ipAddress: request?.ip ?? null, userAgent: String(request?.headers['user-agent'] ?? '').slice(0, 500) || null });
const e2eMode = () => process.env.NODE_ENV === 'test' || process.env.E2E_TEST_MODE === 'true';

@Injectable()
export class AuthService {
  private readonly accessTtlSeconds = Math.max(60, Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900));
  private readonly refreshTtlSeconds = Math.max(300, Number(process.env.REFRESH_TOKEN_TTL_SECONDS ?? 2592000));
  private readonly refreshRotationGraceSeconds = Math.min(120, Math.max(5, Number(process.env.AUTH_REFRESH_ROTATION_GRACE_SECONDS ?? 60)));
  constructor(private readonly db: DatabaseService, private readonly jwt: JwtService, private readonly users: UsersService, private readonly audit: AuditService, private readonly redis: RedisService, private readonly mailer: AccountMailer, @Optional() private readonly entitlement?: EntitlementService) {}

  private async enforceRateLimit(scope: string, identity: string, limit: number, ttlSeconds: number) {
    const key = `zapcall:security:${scope}:${sha256(identity)}`;
    const attempts = await this.redis.client.incr(key);
    if (attempts === 1) await this.redis.client.expire(key, ttlSeconds);
    if (attempts > limit) throw new HttpException('Muitas tentativas. Aguarde alguns minutos.', HttpStatus.TOO_MANY_REQUESTS);
  }

  async login(email: string, password: string, request?: Request) {
    const normalizedEmail = normalizeEmail(email);
    const attemptKey = `zapcall:security:login:${sha256(`${request?.ip ?? 'unknown'}:${normalizedEmail}`)}`;
    const attempt = Number(await this.redis.client.get(attemptKey) ?? 0);
    if (attempt >= 8) {
      throw new HttpException('Muitas tentativas de login. Tente novamente em alguns minutos.', HttpStatus.TOO_MANY_REQUESTS);
    }
    const user = await this.users.findByEmail(normalizedEmail);
    if (!user || user.status !== 'active' || !(await this.users.comparePassword(password, user.password_hash))) {
      const nextAttempt = await this.redis.client.incr(attemptKey);
      if (nextAttempt === 1) await this.redis.client.expire(attemptKey, 15 * 60);
      await this.redis.incrementMetric('login_failed_total');
      await this.audit.record({ action: 'auth.login_failed', metadata: { identityHash: sha256(normalizedEmail) }, ...requestMeta(request) });
      throw new UnauthorizedException('E-mail ou senha inválidos');
    }
    await this.redis.client.del(attemptKey);
    await this.redis.incrementMetric('login_success_total');
    await this.users.markLogin(user.id);
    const session = await this.createSession(user.id, request);
    await this.audit.record({ actorUserId: user.id, action: 'auth.login_success', entityType: 'user', entityId: user.id, ...requestMeta(request) });
    return this.authResponse(user, session.refreshToken, session.id, session.expiresAt, request);
  }

  async registerOrganizer(input: { name: string; email: string; password: string; companyName: string; companySlug?: string; legalAccepted: boolean }, request?: Request) {
    const attemptKey = `zapcall:security:register:${sha256(request?.ip ?? 'unknown')}`;
    const attempts = await this.redis.client.incr(attemptKey);
    if (attempts === 1) await this.redis.client.expire(attemptKey, 15 * 60);
    if (attempts > 6) throw new HttpException('Muitas tentativas de cadastro. Tente novamente em alguns minutos.', HttpStatus.TOO_MANY_REQUESTS);
    const name = input.name.trim();
    const email = normalizeEmail(input.email);
    const companyName = input.companyName.trim();
    const companySlug = slugifyTenant(input.companySlug?.trim() || companyName);
    if (!companySlug) throw new ConflictException('Informe um nome válido para a empresa');
    const passwordHash = await this.users.hashPassword(input.password);
    let created: { user: any; tenant: any };
    try {
      created = await this.db.transaction(async (client) => {
        const existing = await client.query('SELECT 1 FROM users WHERE lower(email) = lower($1) LIMIT 1', [email]);
        if (existing.rows[0]) throw new ConflictException('Este e-mail já possui uma conta');
        const userId = randomUUID();
        const tenantId = randomUUID();
        const tenant = (await client.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3) RETURNING *', [tenantId, companyName, companySlug])).rows[0];
        const user = (await client.query("INSERT INTO users (id, name, email, password_hash, platform_role) VALUES ($1, $2, $3, $4, 'user') RETURNING *", [userId, name, email, passwordHash])).rows[0];
        await client.query("INSERT INTO tenant_memberships (id, tenant_id, user_id, role) VALUES ($1, $2, $3, 'leader')", [randomUUID(), tenantId, userId]);
        await client.query(`INSERT INTO user_legal_acceptances (user_id, legal_document_version_id, ip_address, user_agent)
          SELECT $1, id, $2, $3 FROM legal_document_versions WHERE retired_at IS NULL AND effective_at <= now()
          ON CONFLICT DO NOTHING`, [userId, requestMeta(request).ipAddress, requestMeta(request).userAgent]);
        return { user, tenant };
      });
    } catch (error) {
      if ((error as any)?.code === '23505') throw new ConflictException('O e-mail ou slug da empresa já está cadastrado');
      throw error;
    }
    const session = await this.createSession(created.user.id, request);
    const verificationToken = await this.createActionToken(created.user.id, 'verify_email', 24 * 60 * 60, request);
    await this.mailer.verification(created.user.email, created.user.name, verificationToken).catch(() => undefined);
    await this.audit.record({ actorUserId: created.user.id, tenantId: created.tenant.id, action: 'organizer.registered', entityType: 'tenant', entityId: created.tenant.id, ...requestMeta(request) });
    const auth = await this.authResponse(created.user, session.refreshToken, session.id, session.expiresAt, request);
    return { ...auth, tenant: { id: created.tenant.id, name: created.tenant.name, slug: created.tenant.slug, role: 'leader' }, ...(e2eMode() ? { verificationToken } : {}) };
  }

  async createSessionForUser(userId: string, request?: Request) {
    const user = await this.users.requireById(userId);
    if (user.status !== 'active') throw new UnauthorizedException('Usuário bloqueado');
    await this.users.markLogin(user.id);
    const session = await this.createSession(user.id, request);
    return this.authResponse(user, session.refreshToken, session.id, session.expiresAt, request);
  }

  async refresh(request: Request) {
    const rawToken = this.readRefreshToken(request);
    if (!rawToken) throw new UnauthorizedException('Refresh token ausente');
    const tokenHash = sha256(rawToken);
    const rotated = await this.db.transaction(async (client) => {
      const result = await client.query(`
        SELECT s.*, replacement.revoked_at AS replacement_revoked_at,
          u.name, u.email, u.platform_role, u.status AS user_status,
          u.created_at AS user_created_at, u.last_login_at
        FROM user_sessions s JOIN users u ON u.id = s.user_id
        LEFT JOIN user_sessions replacement ON replacement.id = s.replaced_by_session_id
        WHERE s.refresh_token_hash = $1
        FOR UPDATE OF s
      `, [tokenHash]);
      const current = result.rows[0];
      if (!current) throw new UnauthorizedException('Refresh token inválido');
      const now = Date.now();
      const expired = new Date(current.expires_at).getTime() <= now;
      const rotatedRecently = Boolean(
        current.revoked_at
        && current.replaced_by_session_id
        && current.replacement_revoked_at == null
        && current.rotation_grace_until
        && new Date(current.rotation_grace_until).getTime() > now,
      );
      if (expired) {
        await client.query('UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE family_id = $1 AND revoked_at IS NULL', [current.family_id]);
        throw new UnauthorizedException('Refresh token expirado ou reutilizado');
      }
      if (current.revoked_at && !rotatedRecently) {
        await client.query('UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE family_id = $1 AND revoked_at IS NULL', [current.family_id]);
        throw new UnauthorizedException('Refresh token expirado ou reutilizado');
      }
      if (current.user_status !== 'active') throw new UnauthorizedException('Usuário bloqueado');
      const nextRawToken = randomBytes(48).toString('base64url');
      const nextId = randomUUID();
      const expiresAt = new Date(Date.now() + this.refreshTtlSeconds * 1000);
      await client.query(`INSERT INTO user_sessions (id, user_id, family_id, refresh_token_hash, expires_at, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [nextId, current.user_id, current.family_id, sha256(nextRawToken), expiresAt, requestMeta(request).ipAddress, requestMeta(request).userAgent]);
      if (!current.revoked_at) {
        await client.query('UPDATE user_sessions SET revoked_at = now(), replaced_by_session_id = $1, rotation_grace_until = now() + ($3 * interval \'1 second\'), last_used_at = now() WHERE id = $2', [nextId, current.id, this.refreshRotationGraceSeconds]);
      }
      return {
        user: {
          id: current.user_id,
          name: current.name,
          email: current.email,
          platform_role: current.platform_role,
          status: current.user_status,
          created_at: current.user_created_at,
          last_login_at: current.last_login_at,
        },
        refreshToken: nextRawToken,
        id: nextId,
        expiresAt,
        concurrent: rotatedRecently,
      };
    });
    const result = this.authResponse(rotated.user, rotated.refreshToken, rotated.id, rotated.expiresAt, request);
    // The rotation is already committed and the new cookie can be returned.
    // An audit insert failure must not turn a successful refresh into a 500,
    // leaving the browser with the old (now rotated) cookie.
    await this.audit.record({ actorUserId: rotated.user.id, action: rotated.concurrent ? 'auth.refresh_concurrent' : 'auth.refresh', entityType: 'session', entityId: rotated.id, ...requestMeta(request) }).catch(() => undefined);
    return result;
  }

  async logout(request: Request) {
    const rawToken = this.readRefreshToken(request);
    if (rawToken) await this.db.query('UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, now()), last_used_at = now() WHERE refresh_token_hash = $1', [sha256(rawToken)]);
    await this.audit.record({ action: 'auth.logout', ...requestMeta(request) });
  }

  async logoutAll(userId: string, request?: Request) {
    await this.db.query('UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
    await this.audit.record({ actorUserId: userId, action: 'auth.logout_all', entityType: 'user', entityId: userId, ...requestMeta(request) });
  }

  async forgotPassword(email: string, request?: Request) {
    const normalized = normalizeEmail(email);
    await this.enforceRateLimit('password-forgot-ip', request?.ip ?? 'unknown', 8, 15 * 60);
    await this.enforceRateLimit('password-forgot-email', normalized, 4, 15 * 60);
    const user = await this.users.findByEmail(normalized);
    let testToken: string | undefined;
    if (user?.status === 'active') {
      const token = await this.createActionToken(user.id, 'reset_password', 30 * 60, request);
      testToken = token;
      await this.mailer.passwordReset(user.email, user.name, token).catch(() => undefined);
      await this.audit.record({ actorUserId: user.id, action: 'auth.password_reset_requested', entityType: 'user', entityId: user.id, ...requestMeta(request) });
    }
    return { message: 'Se existir uma conta com este e-mail, enviaremos as instruções.', ...(e2eMode() && testToken ? { resetToken: testToken } : {}) };
  }

  async resetPassword(token: string, password: string, request?: Request) {
    await this.enforceRateLimit('password-reset-ip', request?.ip ?? 'unknown', 12, 15 * 60);
    const passwordHash = await this.users.hashPassword(password);
    const user = await this.db.transaction(async (client) => {
      const result = await client.query(`SELECT t.*, u.email, u.name FROM user_action_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1 AND t.purpose = 'reset_password' FOR UPDATE OF t`, [sha256(token)]);
      const action = result.rows[0];
      if (!action || action.consumed_at || new Date(action.expires_at).getTime() <= Date.now()) { await this.redis.incrementMetric('action_token_failures_total'); throw new BadRequestException('Link inválido, expirado ou já utilizado'); }
      await client.query('UPDATE user_action_tokens SET consumed_at = now(), attempts = attempts + 1 WHERE id = $1', [action.id]);
      await client.query('UPDATE users SET password_hash = $1, password_changed_at = now(), force_password_change = false, updated_at = now() WHERE id = $2', [passwordHash, action.user_id]);
      await client.query('UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1 AND revoked_at IS NULL', [action.user_id]);
      return action;
    });
    await this.mailer.passwordChanged(user.email, user.name).catch(() => undefined);
    await this.audit.record({ actorUserId: user.user_id, action: 'auth.password_reset_completed', entityType: 'user', entityId: user.user_id, ...requestMeta(request) });
    return { ok: true };
  }

  async verifyEmail(token: string, request?: Request) {
    await this.enforceRateLimit('email-verify-ip', request?.ip ?? 'unknown', 20, 15 * 60);
    const userId = await this.db.transaction(async (client) => {
      const result = await client.query(`SELECT * FROM user_action_tokens WHERE token_hash = $1 AND purpose = 'verify_email' FOR UPDATE`, [sha256(token)]);
      const action = result.rows[0];
      if (!action || action.consumed_at || new Date(action.expires_at).getTime() <= Date.now()) { await this.redis.incrementMetric('action_token_failures_total'); throw new BadRequestException('Link inválido, expirado ou já utilizado'); }
      await client.query('UPDATE user_action_tokens SET consumed_at = now(), attempts = attempts + 1 WHERE id = $1', [action.id]);
      await client.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = $1', [action.user_id]);
      return action.user_id as string;
    });
    await this.audit.record({ actorUserId: userId, action: 'auth.email_verified', entityType: 'user', entityId: userId, ...requestMeta(request) });
    return { ok: true };
  }

  async resendVerification(email: string, request?: Request) {
    const normalized = normalizeEmail(email);
    await this.enforceRateLimit('email-resend-ip', request?.ip ?? 'unknown', 8, 15 * 60);
    await this.enforceRateLimit('email-resend-email', normalized, 4, 15 * 60);
    const user = await this.users.findByEmail(normalized);
    if (user?.status === 'active' && !user.email_verified_at) {
      const token = await this.createActionToken(user.id, 'verify_email', 24 * 60 * 60, request);
      await this.mailer.verification(user.email, user.name, token).catch(() => undefined);
    }
    return { message: 'Se a conta estiver pendente, enviaremos um novo link.' };
  }

  async updateProfile(userId: string, name: string, request?: Request) {
    const result = await this.db.query('UPDATE users SET name = $1, updated_at = now() WHERE id = $2 RETURNING *', [name.trim(), userId]);
    if (!result.rows[0]) throw new NotFoundException('Usuário não encontrado');
    await this.audit.record({ actorUserId: userId, action: 'user.profile_changed', entityType: 'user', entityId: userId, ...requestMeta(request) });
    return publicUser(result.rows[0]);
  }

  async changePassword(userId: string, sessionId: string, currentPassword: string, newPassword: string, request?: Request) {
    const user = await this.users.requireById(userId);
    if (!await this.users.comparePassword(currentPassword, user.password_hash)) throw new UnauthorizedException('Senha atual incorreta');
    const passwordHash = await this.users.hashPassword(newPassword);
    await this.db.transaction(async (client) => {
      await client.query('UPDATE users SET password_hash = $1, password_changed_at = now(), force_password_change = false, updated_at = now() WHERE id = $2', [passwordHash, userId]);
      await client.query('UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [userId, sessionId]);
    });
    await this.mailer.passwordChanged(user.email, user.name).catch(() => undefined);
    await this.audit.record({ actorUserId: userId, action: 'user.password_changed', entityType: 'user', entityId: userId, ...requestMeta(request) });
    return { ok: true };
  }

  async listSessions(userId: string, currentSessionId: string) {
    const result = await this.db.query(`SELECT id, family_id, created_at, last_used_at, expires_at, ip_address, user_agent FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`, [userId]);
    return result.rows.map((session) => ({ ...session, current: session.id === currentSessionId }));
  }

  async revokeSession(userId: string, sessionId: string, request?: Request) {
    const result = await this.db.query('UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND user_id = $2 RETURNING id', [sessionId, userId]);
    if (!result.rows[0]) throw new NotFoundException('Sessão não encontrada');
    await this.audit.record({ actorUserId: userId, action: 'auth.session_revoked', entityType: 'session', entityId: sessionId, ...requestMeta(request) });
    return { ok: true, current: sessionId === String((request as any)?.user?.sessionId ?? '') };
  }

  async legalDocuments() {
    return (await this.db.query(`SELECT id, document_type, version, title, url, effective_at FROM legal_document_versions WHERE retired_at IS NULL AND effective_at <= now() ORDER BY document_type`)).rows;
  }

  async acceptCurrentLegalDocuments(userId: string, request?: Request) {
    await this.db.query(`INSERT INTO user_legal_acceptances (user_id, legal_document_version_id, ip_address, user_agent)
      SELECT $1, id, $2, $3 FROM legal_document_versions WHERE retired_at IS NULL AND effective_at <= now() ON CONFLICT DO NOTHING`, [userId, requestMeta(request).ipAddress, requestMeta(request).userAgent]);
    await this.audit.record({ actorUserId: userId, action: 'legal.documents_accepted', entityType: 'user', entityId: userId, ...requestMeta(request) });
    return { ok: true };
  }

  async createWebsocketTicket(userId: string, tenantId: string, requireOperate = false) {
    if (requireOperate) await this.entitlement?.assertCanOperate(tenantId, userId);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 60_000);
    await this.db.query(`
      INSERT INTO websocket_tickets (id, token_hash, user_id, tenant_id, expires_at)
      VALUES ($1, $2, $3, $4, $5)
    `, [randomUUID(), sha256(token), userId, tenantId, expiresAt]);
    return { ticket: token, expiresAt };
  }

  async consumeWebsocketTicket(token: string) {
    return this.db.transaction(async (client) => {
      const result = await client.query(`
        SELECT wt.*, u.name, u.email, u.platform_role, u.status AS user_status
        FROM websocket_tickets wt
        JOIN users u ON u.id = wt.user_id
        JOIN tenants tenant ON tenant.id = wt.tenant_id AND tenant.status = 'active'
        WHERE wt.token_hash = $1
          AND (u.platform_role = 'super_admin' OR EXISTS (
            SELECT 1 FROM tenant_memberships tm
            WHERE tm.tenant_id = wt.tenant_id AND tm.user_id = wt.user_id AND tm.status = 'active'
          ))
        FOR UPDATE
      `, [sha256(token)]);
      const ticket = result.rows[0];
      if (!ticket || ticket.used_at || ticket.user_status !== 'active' || new Date(ticket.expires_at).getTime() <= Date.now()) return null;
      await client.query('UPDATE websocket_tickets SET used_at = now() WHERE id = $1', [ticket.id]);
      return { userId: ticket.user_id, tenantId: ticket.tenant_id, name: ticket.name, platformRole: ticket.platform_role };
    });
  }

  async me(userId: string) {
    const user = await this.users.requireById(userId);
    if (user.status !== 'active') throw new UnauthorizedException('Usuário bloqueado');
    const memberships = await this.db.query(`
      SELECT t.id, t.name, t.slug, t.status, tm.role, tm.status AS membership_status
      FROM tenants t
      LEFT JOIN tenant_memberships tm ON tm.tenant_id = t.id AND tm.user_id = $1 AND tm.status = 'active'
      WHERE t.status = 'active' AND ($2 = 'super_admin' OR tm.user_id IS NOT NULL)
      ORDER BY t.name
    `, [userId, user.platform_role]);
    const missingLegal = await this.db.query(`SELECT d.id, d.document_type, d.version, d.title, d.url FROM legal_document_versions d WHERE d.retired_at IS NULL AND d.effective_at <= now() AND NOT EXISTS (SELECT 1 FROM user_legal_acceptances a WHERE a.user_id = $1 AND a.legal_document_version_id = d.id) ORDER BY d.document_type`, [userId]);
    const tenants = this.entitlement ? await this.entitlement.decorateTenantRows(memberships.rows) : memberships.rows;
    return { user: publicUser(user), tenants, legalAcceptanceRequired: missingLegal.rows.length > 0, pendingLegalDocuments: missingLegal.rows };
  }

  verifyAccessToken(token: string) { return this.jwt.verifyAsync(token); }

  setRefreshCookie(response: Response, token: string) {
    response.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: this.cookieSecure,
      sameSite: process.env.AUTH_COOKIE_SAME_SITE === 'none' ? 'none' : 'lax',
      path: '/api/auth',
      maxAge: this.refreshTtlSeconds * 1000,
    });
  }

  clearRefreshCookie(response: Response) {
    response.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure: this.cookieSecure, sameSite: process.env.AUTH_COOKIE_SAME_SITE === 'none' ? 'none' : 'lax', path: '/api/auth' });
  }

  private get cookieSecure() { return process.env.AUTH_COOKIE_SECURE !== 'false' && process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test'; }

  private async createSession(userId: string, request?: Request) {
    const refreshToken = randomBytes(48).toString('base64url');
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + this.refreshTtlSeconds * 1000);
    await this.db.query(`
      INSERT INTO user_sessions (id, user_id, family_id, refresh_token_hash, expires_at, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [id, userId, id, sha256(refreshToken), expiresAt, requestMeta(request).ipAddress, requestMeta(request).userAgent]);
    return { id, refreshToken, expiresAt };
  }

  private async createActionToken(userId: string, purpose: 'verify_email' | 'reset_password', ttlSeconds: number, request?: Request) {
    const token = randomBytes(48).toString('base64url');
    await this.db.transaction(async (client) => {
      await client.query('UPDATE user_action_tokens SET consumed_at = COALESCE(consumed_at, now()) WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL', [userId, purpose]);
      await client.query('INSERT INTO user_action_tokens (user_id, purpose, token_hash, expires_at, requested_ip) VALUES ($1, $2, $3, $4, $5)', [userId, purpose, sha256(token), new Date(Date.now() + ttlSeconds * 1000), requestMeta(request).ipAddress]);
    });
    return token;
  }

  private async authResponse(user: any, refreshToken: string, sessionId: string, expiresAt: Date, request?: Request) {
    const accessToken = await this.jwt.signAsync({ sub: user.id, sid: sessionId, platformRole: user.platform_role }, { expiresIn: this.accessTtlSeconds });
    return { accessToken, expiresIn: this.accessTtlSeconds, refreshExpiresAt: expiresAt, user: publicUser(user), _refreshToken: refreshToken };
  }

  publicResponse(result: any) {
    const { _refreshToken: _ignoredToken, ...safe } = result;
    return safe;
  }

  private readRefreshToken(request: Request) {
    const raw = String(request.headers.cookie ?? '');
    const cookie = raw.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${REFRESH_COOKIE}=`));
    return cookie ? decodeURIComponent(cookie.slice(REFRESH_COOKIE.length + 1)) : null;
  }
}
