import { ConflictException, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { Request, Response } from 'express';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { UsersService } from '../users/users.service';
import { publicUser, normalizeEmail } from '../users/users.utils';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { slugifyTenant } from '../tenants/tenants.service';

export const REFRESH_COOKIE = 'zapcall_refresh';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const requestMeta = (request?: Request) => ({ ipAddress: request?.ip ?? null, userAgent: String(request?.headers['user-agent'] ?? '').slice(0, 500) || null });

@Injectable()
export class AuthService {
  private readonly accessTtlSeconds = Math.max(60, Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900));
  private readonly refreshTtlSeconds = Math.max(300, Number(process.env.REFRESH_TOKEN_TTL_SECONDS ?? 2592000));
  constructor(private readonly db: DatabaseService, private readonly jwt: JwtService, private readonly users: UsersService, private readonly audit: AuditService, private readonly redis: RedisService) {}

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
      await this.audit.record({ action: 'auth.login_failed', metadata: { email: normalizedEmail }, ...requestMeta(request) });
      throw new UnauthorizedException('E-mail ou senha inválidos');
    }
    await this.redis.client.del(attemptKey);
    await this.users.markLogin(user.id);
    const session = await this.createSession(user.id, request);
    await this.audit.record({ actorUserId: user.id, action: 'auth.login_success', entityType: 'user', entityId: user.id, ...requestMeta(request) });
    return this.authResponse(user, session.refreshToken, session.id, session.expiresAt, request);
  }

  async registerOrganizer(input: { name: string; email: string; password: string; companyName: string; companySlug?: string }, request?: Request) {
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
        return { user, tenant };
      });
    } catch (error) {
      if ((error as any)?.code === '23505') throw new ConflictException('O e-mail ou slug da empresa já está cadastrado');
      throw error;
    }
    const session = await this.createSession(created.user.id, request);
    await this.audit.record({ actorUserId: created.user.id, tenantId: created.tenant.id, action: 'organizer.registered', entityType: 'tenant', entityId: created.tenant.id, ...requestMeta(request) });
    const auth = await this.authResponse(created.user, session.refreshToken, session.id, session.expiresAt, request);
    return { ...auth, tenant: { id: created.tenant.id, name: created.tenant.name, slug: created.tenant.slug, role: 'leader' } };
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
        SELECT s.*, u.name, u.email, u.platform_role, u.status AS user_status, u.created_at AS user_created_at, u.last_login_at
        FROM user_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.refresh_token_hash = $1
        FOR UPDATE
      `, [tokenHash]);
      const current = result.rows[0];
      if (!current) throw new UnauthorizedException('Refresh token inválido');
      if (current.revoked_at || new Date(current.expires_at).getTime() <= Date.now()) {
        await client.query('UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE family_id = $1 AND revoked_at IS NULL', [current.family_id]);
        throw new UnauthorizedException('Refresh token expirado ou reutilizado');
      }
      if (current.user_status !== 'active') throw new UnauthorizedException('Usuário bloqueado');
      const nextRawToken = randomBytes(48).toString('base64url');
      const nextId = randomUUID();
      const expiresAt = new Date(Date.now() + this.refreshTtlSeconds * 1000);
      await client.query(`INSERT INTO user_sessions (id, user_id, family_id, refresh_token_hash, expires_at, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [nextId, current.user_id, current.family_id, sha256(nextRawToken), expiresAt, requestMeta(request).ipAddress, requestMeta(request).userAgent]);
      await client.query('UPDATE user_sessions SET revoked_at = now(), replaced_by_session_id = $1, last_used_at = now() WHERE id = $2', [nextId, current.id]);
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
      };
    });
    const result = this.authResponse(rotated.user, rotated.refreshToken, rotated.id, rotated.expiresAt, request);
    await this.audit.record({ actorUserId: rotated.user.id, action: 'auth.refresh', entityType: 'session', entityId: rotated.id, ...requestMeta(request) });
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

  async createWebsocketTicket(userId: string, tenantId: string) {
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
        WHERE wt.token_hash = $1
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
    return { user: publicUser(user), tenants: memberships.rows };
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
    response.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure: this.cookieSecure, sameSite: 'lax', path: '/api/auth' });
  }

  private get cookieSecure() { return process.env.AUTH_COOKIE_SECURE === 'true' || (process.env.NODE_ENV === 'production' && process.env.AUTH_COOKIE_SECURE !== 'false'); }

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
