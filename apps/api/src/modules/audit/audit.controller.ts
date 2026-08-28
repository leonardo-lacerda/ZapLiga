import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentTenant, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { AuditService } from './audit.service';

@Controller()
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get('/api/admin/audit')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('super_admin')
  list(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('tenantId') tenantId?: string,
    @Query('actorId') actorId?: string,
    @Query('action') action?: string,
    @Query('search') search?: string,
  ) { return this.audit.list(Number(limit), Number(offset), { tenantId, actorId, action, search }); }

  @Get('/api/tenants/:tenantId/audit')
  @UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
  @Roles('leader', 'super_admin')
  listTenant(@CurrentTenant() tenantId: string, @Query('limit') limit?: string, @Query('offset') offset?: string) { return this.audit.listForTenant(tenantId, Number(limit), Number(offset)); }
}
