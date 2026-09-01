import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { Request, Response } from 'express';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';

const browserCookie = 'zapliga_browser';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const requestMeta = (request?: Request) => ({ ipAddress: request?.ip ?? null, userAgent: String(request?.headers['user-agent'] ?? '').slice(0, 500) || null });

@Injectable()
export class AccountSwitcherService {
  constructor(private readonly db: DatabaseService, private readonly users: UsersService, private readonly auth: AuthService, private readonly audit: AuditService) {}

  private get cookieSecure() { return process.env.AUTH_COOKIE_SECURE !== 'false' && process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test'; }

  private browserId(request: Request, response?: Response) {
    const cookies = String(request.headers.cookie ?? '').split(';').map((part) => part.trim());
    const existing = cookies.find((part) => part.startsWith(`${browserCookie}=`))?.slice(browserCookie.length + 1);
    if (existing && /^[A-Za-z0-9_-]{32,128}$/.test(existing)) return decodeURIComponent(existing);
    const value = randomBytes(32).toString('base64url');
    response?.cookie(browserCookie, value, { httpOnly: true, secure: this.cookieSecure, sameSite: 'lax', path: '/', maxAge: 365 * 24 * 60 * 60 * 1000 });
    return value;
  }

  private async link(browserId: string, userId: string) {
    await this.db.query(`INSERT INTO browser_account_links (id, browser_id_hash, user_id, last_used_at) VALUES ($1,$2,$3,now()) ON CONFLICT (browser_id_hash, user_id) DO UPDATE SET last_used_at = now()`, [randomUUID(), sha256(browserId), userId]);
  }

  async list(userId: string, request: Request, response: Response) {
    const browser = this.browserId(request, response);
    await this.link(browser, userId);
    const result = await this.db.query(`SELECT u.id, u.name, u.email, u.platform_role, bal.last_used_at FROM browser_account_links bal JOIN users u ON u.id = bal.user_id WHERE bal.browser_id_hash = $1 AND u.status = 'active' ORDER BY bal.last_used_at DESC NULLS LAST, bal.created_at ASC`, [sha256(browser)]);
    return result.rows.map((row) => ({ id: row.id, name: row.name, email: row.email, platformRole: row.platform_role, lastUsedAt: row.last_used_at, current: row.id === userId }));
  }

  async add(currentUserId: string, email: string, password: string, request: Request, response: Response) {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !password) throw new BadRequestException('Informe o e-mail e a senha da conta');
    const target = await this.users.findByEmail(normalizedEmail);
    if (!target || target.status !== 'active' || !(await this.users.comparePassword(password, target.password_hash))) throw new UnauthorizedException('E-mail ou senha inválidos');
    if (target.id === currentUserId) throw new BadRequestException('Esta conta já está ativa');
    const browser = this.browserId(request, response);
    await this.link(browser, target.id);
    const result = await this.auth.createSessionForUser(target.id, request);
    this.auth.setRefreshCookie(response, result._refreshToken);
    await this.audit.record({ actorUserId: currentUserId, action: 'auth.account_added', entityType: 'user', entityId: target.id, ...requestMeta(request) });
    return this.auth.publicResponse(result);
  }

  async switch(currentUserId: string, targetUserId: string, request: Request, response: Response) {
    if (currentUserId === targetUserId) return { switched: false };
    const browser = this.browserId(request, response);
    const link = await this.db.query(`SELECT u.id FROM browser_account_links bal JOIN users u ON u.id = bal.user_id WHERE bal.browser_id_hash = $1 AND bal.user_id = $2 AND u.status = 'active' LIMIT 1`, [sha256(browser), targetUserId]);
    if (!link.rows[0]) throw new UnauthorizedException('Conta não autorizada neste navegador');
    await this.db.query('UPDATE browser_account_links SET last_used_at = now() WHERE browser_id_hash = $1 AND user_id = $2', [sha256(browser), targetUserId]);
    const result = await this.auth.createSessionForUser(targetUserId, request);
    this.auth.setRefreshCookie(response, result._refreshToken);
    await this.audit.record({ actorUserId: currentUserId, action: 'auth.account_switched', entityType: 'user', entityId: targetUserId, metadata: { fromUserId: currentUserId }, ...requestMeta(request) });
    return this.auth.publicResponse(result);
  }

  async remove(currentUserId: string, targetUserId: string, request: Request) {
    if (currentUserId === targetUserId) throw new BadRequestException('A conta ativa não pode ser removida daqui');
    const browser = this.browserId(request);
    const result = await this.db.query('DELETE FROM browser_account_links WHERE browser_id_hash = $1 AND user_id = $2 RETURNING id', [sha256(browser), targetUserId]);
    if (!result.rows[0]) throw new UnauthorizedException('Conta não encontrada neste navegador');
    await this.audit.record({ actorUserId: currentUserId, action: 'auth.account_removed', entityType: 'user', entityId: targetUserId, ...requestMeta(request) });
    return { ok: true };
  }
}
