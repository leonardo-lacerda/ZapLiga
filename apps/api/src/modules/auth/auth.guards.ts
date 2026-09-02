import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Optional, SetMetadata, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthenticatedUser, TenantRole } from './auth.types';
import { AuthService } from './auth.service';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { RedisService } from '../../infrastructure/redis/redis.service';

export const ROLES_KEY = 'zapcall_roles';
export const Roles = (...roles: Array<TenantRole | 'super_admin'>) => SetMetadata(ROLES_KEY, roles);

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
  return request.user;
});

export const CurrentTenant = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<{ tenantId?: string }>();
  return request.tenantId;
});

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService, private readonly db: DatabaseService, @Optional() private readonly redis?: RedisService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<any>();
    const header = String(request.headers.authorization ?? '');
    if (!header.startsWith('Bearer ')) throw new UnauthorizedException('Autenticação necessária');
    let payload: any;
    try { payload = await this.auth.verifyAccessToken(header.slice(7)); }
    catch { await this.redis?.incrementMetric('access_token_failures_total'); throw new UnauthorizedException('Sessão inválida ou expirada'); }
    const result = await this.db.query(`SELECT u.id, u.platform_role, u.status, u.email_verified_at, u.force_password_change,
        (SELECT count(*)::int FROM legal_document_versions d WHERE d.retired_at IS NULL AND d.effective_at <= now() AND NOT EXISTS (SELECT 1 FROM user_legal_acceptances a WHERE a.user_id = u.id AND a.legal_document_version_id = d.id)) AS pending_legal_count
      FROM users u JOIN user_sessions s ON s.user_id = u.id AND s.id = $2
      WHERE u.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now() LIMIT 1`, [String(payload.sub), String(payload.sid ?? '')]);
    const user = result.rows[0];
    if (!user || user.status !== 'active') { await this.redis?.incrementMetric('revoked_session_access_total'); throw new UnauthorizedException('Usuário bloqueado ou inexistente'); }
    const gatePaths = new Set(['/api/auth/me', '/api/auth/logout', '/api/auth/logout-all', '/api/me/profile', '/api/me/password', '/api/me/sessions', '/api/me/legal-acceptance']);
    const requestPath = String(request.path ?? '');
    const accountGateAllowed = gatePaths.has(requestPath) || requestPath.startsWith('/api/me/sessions/') || requestPath === '/api/auth/accounts' || requestPath.startsWith('/api/auth/accounts/');
    if (!accountGateAllowed) {
      if (!user.email_verified_at) throw new ForbiddenException({ code: 'email_verification_required', message: 'Verifique seu e-mail antes de continuar' });
      if (Number(user.pending_legal_count ?? 0) > 0) throw new ForbiddenException({ code: 'legal_acceptance_required', message: 'Aceite os documentos legais vigentes antes de continuar' });
      if (user.force_password_change) throw new ForbiddenException({ code: 'password_change_required', message: 'Altere sua senha temporária antes de continuar' });
    }
    request.user = { id: user.id, platformRole: user.platform_role, sessionId: String(payload.sid ?? ''), tenantMembership: undefined } satisfies AuthenticatedUser;
    return true;
  }
}

@Injectable()
export class TenantMembershipGuard implements CanActivate {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly redis: RedisService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<any>();
    const user = request.user as AuthenticatedUser | undefined;
    const routeTenantId = String(request.params?.tenantId ?? '');
    const headerTenantId = String(request.headers['x-tenant-id'] ?? '');
    if (routeTenantId && headerTenantId && routeTenantId !== headerTenantId) throw new UnauthorizedException('Os contextos da empresa não coincidem');
    const tenantId = routeTenantId || headerTenantId;
    if (!user || !tenantId) throw new UnauthorizedException('Contexto da empresa inválido');
    const tenant = await this.db.query('SELECT id, status FROM tenants WHERE id = $1 LIMIT 1', [tenantId]);
    if (!tenant.rows[0] || tenant.rows[0].status !== 'active') throw new UnauthorizedException('Empresa inexistente ou inativa');
    if (user.platformRole === 'super_admin') {
      request.user.tenantMembership = { tenantId, role: 'leader', status: 'active' };
      request.tenantId = tenantId;
      const auditKey = `${user.id}:${tenantId}`;
      const shouldAudit = await this.redis.client.set(`zapcall:audit:admin-access:${auditKey}`, '1', 'EX', 300, 'NX');
      if (shouldAudit === 'OK') {
        await this.audit.record({ actorUserId: user.id, tenantId, action: 'tenant.admin_access', entityType: 'tenant', entityId: tenantId });
      }
      return true;
    }
    const result = await this.db.query(`
      SELECT tm.tenant_id, tm.role, tm.status, t.status AS tenant_status
      FROM tenant_memberships tm
      JOIN tenants t ON t.id = tm.tenant_id
      WHERE tm.user_id = $1 AND tm.tenant_id = $2
      LIMIT 1
    `, [user.id, tenantId]);
    const membership = result.rows[0];
    if (!membership || membership.status !== 'active' || membership.tenant_status !== 'active') throw new UnauthorizedException('Usuário sem acesso a esta empresa');
    request.user.tenantMembership = { tenantId: membership.tenant_id, role: membership.role, status: membership.status };
    request.tenantId = membership.tenant_id;
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext) {
    const roles = this.reflector.getAllAndOverride<Array<TenantRole | 'super_admin'>>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (!roles?.length) return true;
    const request = context.switchToHttp().getRequest<any>();
    const user = request.user as AuthenticatedUser | undefined;
    if (user?.platformRole === 'super_admin' && roles.includes('super_admin')) return true;
    if (roles.includes(user?.tenantMembership?.role as TenantRole)) return true;
    throw new ForbiddenException('Você não tem permissão para esta ação');
  }
}
