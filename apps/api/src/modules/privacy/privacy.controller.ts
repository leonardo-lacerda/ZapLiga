import { Body, Controller, Get, Header, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantAction, TenantMembershipGuard } from '../auth/auth.guards';
import { CreateDataSubjectRequestDto, RejectDataSubjectRequestDto } from './dto/privacy.dto';
import { PrivacyService } from './privacy.service';
import { FeatureFlagGuard, RequiresFeature } from '../feature-flags/feature-flags.guard';

@Controller()
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard, FeatureFlagGuard)
@RequiresFeature('privacy_requests')
@Roles('leader', 'super_admin')
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}
  @Get(['/api/privacy/subjects/search', '/api/tenants/:tenantId/privacy/subjects/search']) search(@CurrentTenant() tenantId: string, @Query('phone') phone: string) { return this.privacy.subject(tenantId, phone); }
  @Get(['/api/privacy/requests', '/api/tenants/:tenantId/privacy/requests']) list(@CurrentTenant() tenantId: string) { return this.privacy.list(tenantId); }
  @Post(['/api/privacy/requests', '/api/tenants/:tenantId/privacy/requests']) @TenantAction('legal_compliance') create(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Body() body: CreateDataSubjectRequestDto) { return this.privacy.createRequest(tenantId, body.phone, body.requestType, body.details, user.id); }
  @Post(['/api/privacy/requests/:id/process', '/api/tenants/:tenantId/privacy/requests/:id/process']) @TenantAction('legal_compliance') process(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Param('id') id: string) { return this.privacy.startProcessing(tenantId, id, user.id); }
  @Post(['/api/privacy/requests/:id/reject', '/api/tenants/:tenantId/privacy/requests/:id/reject']) @TenantAction('legal_compliance') reject(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Param('id') id: string, @Body() body: RejectDataSubjectRequestDto) { return this.privacy.reject(tenantId, id, body.reason, user.id); }
  @Get(['/api/privacy/requests/:id/export', '/api/tenants/:tenantId/privacy/requests/:id/export']) @Header('Content-Disposition', 'attachment; filename="dados-do-titular.json"') export(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Param('id') id: string) { return this.privacy.downloadExport(tenantId, id, user.id); }
}
