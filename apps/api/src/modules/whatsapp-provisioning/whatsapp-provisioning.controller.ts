import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post, Put, Query, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { FeatureFlagGuard, RequiresFeature } from '../feature-flags/feature-flags.guard';
import { AssignEgressNodeDto, CreatePhoneDto, CreateProvisioningJobDto, LinkDecisionDto, ManualActionDto, RenamePhoneDto, RequestCodeDto, SubmitProfileDto, SubmitSmsCodeDto } from './dto/provisioning.dto';
import { MAX_PROFILE_PHOTO_BYTES, WhatsappProvisioningService } from './whatsapp-provisioning.service';

/** WhatsApp registration on GeeLark cloud phones (internal; docs/provisioning-contract.md section 3). */
@Controller('/api/tenants/:tenantId/provisioning')
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard, FeatureFlagGuard)
@RequiresFeature('whatsapp_provisioning')
@Roles('leader', 'super_admin')
export class WhatsappProvisioningController {
  constructor(private readonly provisioning: WhatsappProvisioningService) {}

  @Get('/egress')
  egress(@CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.provisioning.listEgress(tenantId, user.id); }

  @Put('/egress/:node')
  assignEgress(@Param('node') node: string, @Body() body: AssignEgressNodeDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    return this.provisioning.assignEgress(tenantId, user.id, node, body.userId ?? null);
  }

  @Get('/phones')
  phones() { return this.provisioning.listPhones(); }

  @Post('/phones')
  createPhone(@Body() body: CreatePhoneDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.provisioning.createPhone(tenantId, user.id, body); }

  @Post('/jobs')
  create(@Body() body: CreateProvisioningJobDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.provisioning.createJob(tenantId, user.id, body); }

  @Post('/phones/:id/stop')
  @HttpCode(200)
  stopPhone(@Param('id') id: string, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.provisioning.powerOffPhone(tenantId, user.id, id); }

  @Post('/phones/:id/rename')
  @HttpCode(200)
  renamePhone(@Param('id') id: string, @Body() body: RenamePhoneDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.provisioning.renamePhone(tenantId, user.id, id, body.name); }

  @Post('/phones/:id/new-device')
  @HttpCode(200)
  newDevice(@Param('id') id: string, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.provisioning.newDevice(tenantId, user.id, id); }

  @Delete('/phones/:id')
  deletePhone(@Param('id') id: string, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.provisioning.deletePhone(tenantId, user.id, id); }

  @Get('/jobs')
  list(@Query('limit') limit: string | undefined, @CurrentTenant() tenantId: string) { return this.provisioning.listJobs(tenantId, Number(limit)); }

  @Get('/jobs/:id')
  get(@Param('id') id: string, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.provisioning.getJob(tenantId, user.id, id); }

  @Post('/jobs/:id/sms')
  @HttpCode(200)
  sms(@Param('id') id: string, @Body() body: SubmitSmsCodeDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.provisioning.submitSms(tenantId, user.id, id, body.code); }

  @Post('/jobs/:id/resend')
  @HttpCode(200)
  resend(@Param('id') id: string, @Body() body: RequestCodeDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.provisioning.requestNewCode(tenantId, user.id, id, body.method); }

  @Post('/jobs/:id/manual')
  @HttpCode(200)
  manual(@Param('id') id: string, @Body() body: ManualActionDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    const action = body.type === 'tap' ? { type: 'tap' as const, x: Number(body.x), y: Number(body.y) }
      : body.type === 'key' ? { type: 'key' as const, key: body.key! }
        : { type: 'text' as const, text: String(body.text) };
    return this.provisioning.manualAction(tenantId, user.id, id, action);
  }

  @Post('/jobs/:id/takeover')
  @HttpCode(200)
  takeOver(@Param('id') id: string, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.provisioning.takeOver(tenantId, user.id, id); }

  @Post('/jobs/:id/resume')
  @HttpCode(200)
  resume(@Param('id') id: string, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.provisioning.resumeRobot(tenantId, user.id, id); }

  @Get('/jobs/:id/screen')
  @Header('Cache-Control', 'no-store')
  async screen(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return new StreamableFile(await this.provisioning.liveScreen(tenantId, id), { type: 'image/png' });
  }

  @Post('/jobs/:id/profile')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: MAX_PROFILE_PHOTO_BYTES, files: 1, fields: 5 } }))
  profile(@Param('id') id: string, @Body() body: SubmitProfileDto, @UploadedFile() photo: Express.Multer.File | undefined, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    return this.provisioning.submitProfile(tenantId, user.id, id, body.name, photo);
  }

  @Post('/jobs/:id/link')
  @HttpCode(200)
  link(@Param('id') id: string, @Body() body: LinkDecisionDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.provisioning.decideLink(tenantId, user.id, id, body.connect); }

  @Post('/jobs/:id/cancel')
  @HttpCode(200)
  cancel(@Param('id') id: string, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.provisioning.cancel(tenantId, user.id, id); }

  @Get('/jobs/:id/screenshot')
  @Header('Cache-Control', 'no-store')
  async screenshot(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return new StreamableFile(await this.provisioning.screenshot(tenantId, id), { type: 'image/png' });
  }
}
