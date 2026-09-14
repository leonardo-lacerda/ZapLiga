import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthGuard, CurrentUser, Roles, RolesGuard } from '../auth/auth.guards';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { UpdateTenantStatusDto } from './dto/update-tenant-status.dto';
import { UpdateTenantLimitsDto } from './dto/update-tenant-limits.dto';
import { TenantsService } from './tenants.service';

@Controller()
export class TenantsController {
  constructor(private readonly tenants: TenantsService, private readonly audit: AuditService) {}

  @Post('/api/tenants')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('super_admin')
  async create(@Body() body: CreateTenantDto, @CurrentUser() user: any) {
    const tenant = await this.tenants.create(body.name, body.slug);
    await this.audit.record({ actorUserId: user.id, tenantId: tenant.id, action: 'tenant.created', entityType: 'tenant', entityId: tenant.id, metadata: { name: tenant.name } });
    return tenant;
  }

  @Get('/api/tenants')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('super_admin')
  listAll() { return this.tenants.listAll(); }

  @Get('/api/me/tenants')
  @UseGuards(AuthGuard)
  listMine(@CurrentUser() user: any) { return this.tenants.listForUser(user.id); }

  @Patch('/api/tenants/:tenantId/status')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('super_admin')
  async status(@Param('tenantId') tenantId: string, @Body() body: UpdateTenantStatusDto, @CurrentUser() user: any) {
    const tenant = await this.tenants.setStatus(tenantId, body.status);
    await this.audit.record({ actorUserId: user.id, tenantId, action: 'tenant.status_changed', entityType: 'tenant', entityId: tenantId, metadata: { status: body.status } });
    return tenant;
  }

  @Patch('/api/tenants/:tenantId/limits')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('super_admin')
  async limits(@Param('tenantId') tenantId: string, @Body() body: UpdateTenantLimitsDto, @CurrentUser() user: any) {
    const tenant = await this.tenants.setLimits(tenantId, body);
    await this.audit.record({ actorUserId: user.id, tenantId, action: 'tenant.lead_limit_changed', entityType: 'tenant', entityId: tenantId, metadata: body as Record<string, unknown> });
    return tenant;
  }
}
