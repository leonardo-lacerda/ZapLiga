import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthenticatedUser, TenantRole } from './auth.types';
import { AuthService } from './auth.service';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';

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
  constructor(private readonly auth: AuthService, private readonly db: DatabaseService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<any>();
    const header = String(request.headers.authorization ?? '');
    if (!header.startsWith('Bearer ')) throw new UnauthorizedException('Autenticação necessária');
    let payload: any;
    try { payload = await this.auth.verifyAccessToken(header.slice(7)); }
    catch { throw new UnauthorizedException('Sessão inválida ou expirada'); }
    const result = await this.db.query('SELECT id, platform_role, status FROM users WHERE id = $1 LIMIT 1', [String(payload.sub)]);
    const user = result.rows[0];
    if (!user || user.status !== 'active') throw new UnauthorizedException('Usuário bloqueado ou inexistente');
    request.user = { id: user.id, platformRole: user.platform_role, sessionId: String(payload.sid ?? ''), tenantMembership: undefined } satisfies AuthenticatedUser;
    return true;
  }
}

@Injectable()
export class TenantMembershipGuard implements CanActivate {
  private readonly recentAdminAccess = new Map<string, number>();

  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<any>();
    const user = request.user as AuthenticatedUser | undefined;
    const routeTenantId = String(request.params?.tenantId ?? '');
    const headerTenantId = String(request.headers['x-tenant-id'] ?? '');
    if (routeTenantId && headerTenantId && routeTenantId !== headerTenantId) throw new UnauthorizedException('Os contextos da empresa nÃ£o coincidem');
    const tenantId = routeTenantId || headerTenantId;
    if (!user || !tenantId) throw new UnauthorizedException('Contexto da empresa inválido');
    const tenant = await this.db.query('SELECT id, status FROM tenants WHERE id = $1 LIMIT 1', [tenantId]);
    if (!tenant.rows[0] || tenant.rows[0].status !== 'active') throw new UnauthorizedException('Empresa inexistente ou inativa');
    if (user.platformRole === 'super_admin') {
      request.user.tenantMembership = { tenantId, role: 'leader', status: 'active' };
      request.tenantId = tenantId;
      const auditKey = `${user.id}:${tenantId}`;
      const lastAudit = this.recentAdminAccess.get(auditKey) ?? 0;
      if (Date.now() - lastAudit > 5 * 60_000) {
        this.recentAdminAccess.set(auditKey, Date.now());
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
