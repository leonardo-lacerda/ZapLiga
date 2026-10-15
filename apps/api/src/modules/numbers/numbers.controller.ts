import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { CreateNumberDto } from './dto/create-number.dto';
import { UpdateNumberDto } from './dto/update-number.dto';
import { NumbersService } from './numbers.service';

@Controller()
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
export class NumbersController {
  constructor(private readonly numbers: NumbersService) {}

  @Roles('leader', 'super_admin')
  @Post(['/api/numbers', '/api/tenants/:tenantId/numbers'])
  create(@Body() body: CreateNumberDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.numbers.create(tenantId, user.id, body); }

  @Roles('leader', 'super_admin')
  @Get(['/api/numbers', '/api/tenants/:tenantId/numbers'])
  list(@Query('limit') limit = '100', @Query('offset') offset = '0', @CurrentTenant() tenantId: string) { return this.numbers.list(tenantId, Number(limit), Number(offset)); }

  @Roles('leader', 'super_admin')
  @Delete(['/api/numbers/:id', '/api/tenants/:tenantId/numbers/:id'])
  remove(@Param('id') id: string, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.numbers.remove(tenantId, user.id, id); }

  @Roles('leader', 'super_admin')
  @Get(['/api/numbers/:id/qr', '/api/tenants/:tenantId/numbers/:id/qr'])
  qr(@Param('id') id: string, @CurrentTenant() tenantId: string) { return this.numbers.qr(tenantId, id); }

  @Roles('leader', 'super_admin')
  @Post(['/api/numbers/:id/reconnect', '/api/tenants/:tenantId/numbers/:id/reconnect'])
  reconnect(@Param('id') id: string, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.numbers.reconnect(tenantId, user.id, id); }

  @Roles('leader', 'super_admin')
  @Patch(['/api/numbers/:id/settings', '/api/tenants/:tenantId/numbers/:id/settings'])
  settings(@Param('id') id: string, @Body() body: UpdateNumberDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.numbers.updateSettings(tenantId, user.id, id, body); }
}
