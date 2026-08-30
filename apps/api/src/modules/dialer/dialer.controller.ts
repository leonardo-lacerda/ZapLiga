import { Body, Controller, Get, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { DialerService } from './dialer.service';
import { UpdateDialerSettingsDto } from './dto/update-dialer-settings.dto';
import { AuditService } from '../audit/audit.service';

@Controller()
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
export class DialerController {
  constructor(private readonly dialer: DialerService, private readonly audit: AuditService) {}

  @Get(['/api/dialer/status', '/api/tenants/:tenantId/dialer/status']) @Roles('leader', 'super_admin') status(@Query('from') from: string | undefined, @Query('to') to: string | undefined, @CurrentTenant() tenantId: string) { return this.dialer.getStatus(tenantId, from, to); }
  @Get(['/api/dialer/sdr-status', '/api/tenants/:tenantId/dialer/sdr-status']) @Roles('sdr') sdrStatus(@CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.dialer.getSdrStatus(tenantId, user.id); }
  @Get(['/api/dialer/sdr-metrics', '/api/tenants/:tenantId/dialer/sdr-metrics']) @Roles('sdr') sdrMetrics(@Query('from') from: string | undefined, @Query('to') to: string | undefined, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.dialer.getSdrMetrics(tenantId, user.id, from, to); }
  @Get(['/api/dialer/logs', '/api/tenants/:tenantId/dialer/logs']) @Roles('leader', 'super_admin') logs(@CurrentTenant() tenantId: string) { return this.dialer.getLogs(tenantId); }
  @Post(['/api/dialer/start', '/api/tenants/:tenantId/dialer/start']) @Roles('leader', 'super_admin') async start(@CurrentTenant() tenantId: string, @CurrentUser() user: any) { const result = await this.dialer.start(tenantId); await this.audit.record({ actorUserId: user.id, tenantId, action: 'dialer.started', entityType: 'dialer' }); return result; }
  @Post(['/api/dialer/pause', '/api/tenants/:tenantId/dialer/pause']) @Roles('leader', 'super_admin') async pause(@CurrentTenant() tenantId: string, @CurrentUser() user: any) { const result = await this.dialer.pause(tenantId); await this.audit.record({ actorUserId: user.id, tenantId, action: 'dialer.paused', entityType: 'dialer' }); return result; }
  @Patch(['/api/dialer/settings', '/api/tenants/:tenantId/dialer/settings']) @Roles('leader', 'super_admin') async settings(@Body() body: UpdateDialerSettingsDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { const payload = body as Record<string, unknown>; const result = await this.dialer.updateSettings(payload, tenantId); await this.audit.record({ actorUserId: user.id, tenantId, action: 'dialer.settings_changed', entityType: 'dialer', metadata: payload }); return result; }
}
