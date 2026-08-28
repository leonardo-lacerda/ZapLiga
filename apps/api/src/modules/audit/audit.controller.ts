import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentTenant, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { AuditService } from './audit.service';

@Controller()
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get('/api/admin/audit')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('super_admin')
  list(@Query('limit') limit?: string, @Query('offset') offset?: string) { return this.audit.list(Number(limit), Number(offset)); }

  @Get('/api/tenants/:tenantId/audit')
  @UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
  @Roles('leader', 'super_admin')
  listTenant(@CurrentTenant() tenantId: string, @Query('limit') limit?: string, @Query('offset') offset?: string) { return this.audit.listForTenant(tenantId, Number(limit), Number(offset)); }
}
