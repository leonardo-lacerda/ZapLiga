import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Param, Patch, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantAction, TenantMembershipGuard } from '../auth/auth.guards';
import { LeadFoldersService } from './lead-folders.service';
import { CreateLeadFolderDto } from './dto/create-lead-folder.dto';
import { UpdateLeadFolderDto } from './dto/update-lead-folder.dto';

@Controller()
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
@Roles('leader', 'super_admin')
export class LeadFoldersController {
  constructor(private readonly folders: LeadFoldersService) {}

  @Get(['/api/lead-folders', '/api/tenants/:tenantId/lead-folders'])
  list(@CurrentTenant() tenantId: string) { return this.folders.list(tenantId); }

  @Post(['/api/lead-folders', '/api/tenants/:tenantId/lead-folders'])
  @TenantAction('write')
  create(@Body() body: CreateLeadFolderDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.folders.create(body, tenantId, user.id); }

  @Get(['/api/lead-folders/:id', '/api/tenants/:tenantId/lead-folders/:id'])
  get(@Param('id') id: string, @CurrentTenant() tenantId: string) { return this.folders.get(id, tenantId); }

  @Patch(['/api/lead-folders/:id', '/api/tenants/:tenantId/lead-folders/:id'])
  @TenantAction('write')
  update(@Param('id') id: string, @Body() body: UpdateLeadFolderDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.folders.update(id, body, tenantId, user.id); }

  @Delete(['/api/lead-folders/:id', '/api/tenants/:tenantId/lead-folders/:id'])
  @TenantAction('write')
  remove(@Param('id') id: string, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.folders.remove(id, tenantId, user.id); }

  @Get(['/api/lead-folders/:id/leads', '/api/tenants/:tenantId/lead-folders/:id/leads'])
  leads(@Param('id') id: string, @Query('status') status: string | undefined, @Query('limit') limit: string | undefined, @Query('offset') offset: string | undefined, @CurrentTenant() tenantId: string) { return this.folders.listLeads(id, tenantId, status, limit, offset); }

  @Post(['/api/lead-folders/:id/leads', '/api/tenants/:tenantId/lead-folders/:id/leads'])
  @TenantAction('write')
  createLead(@Param('id') id: string, @Body() body: { name: string; phone: string }, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.folders.createLead(id, body, tenantId, user.id); }

  @Post(['/api/lead-folders/:id/import', '/api/tenants/:tenantId/lead-folders/:id/import'])
  @TenantAction('write')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  import(@Param('id') id: string, @UploadedFile() file: Express.Multer.File, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.folders.import(id, file, tenantId, user.id); }

  @Delete(['/api/lead-folders/:id/leads', '/api/tenants/:tenantId/lead-folders/:id/leads'])
  @TenantAction('write')
  clear(@Param('id') id: string, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.folders.clear(id, tenantId, user.id); }

  @Get(['/api/lead-folders/:id/metrics', '/api/tenants/:tenantId/lead-folders/:id/metrics'])
  metrics(@Param('id') id: string, @Query('from') from: string | undefined, @Query('to') to: string | undefined, @CurrentTenant() tenantId: string) { return this.folders.metrics(id, tenantId, from, to); }
}
