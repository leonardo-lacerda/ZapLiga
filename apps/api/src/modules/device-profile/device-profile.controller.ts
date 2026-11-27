import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { SetDeviceProfileDto } from './dto/set-device-profile.dto';
import { DeviceProfileService } from './device-profile.service';

/** New camouflage per line (docs/device-profile.md): chosen by the ZapLiga team, line by line. */
@Controller()
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
export class DeviceProfileController {
  constructor(private readonly deviceProfile: DeviceProfileService) {}

  @Roles('super_admin')
  @Patch(['/api/numbers/:id/device-profile', '/api/tenants/:tenantId/numbers/:id/device-profile'])
  set(@Param('id') id: string, @Body() body: SetDeviceProfileDto, @CurrentTenant() tenantId: string, @CurrentUser() user: { id: string }) {
    return this.deviceProfile.setChoice(tenantId, user.id, id, body.enabled, body.multiloginPhoneId);
  }

  @Roles('super_admin')
  @Get(['/api/multilogin/phones', '/api/tenants/:tenantId/multilogin/phones'])
  phones() {
    return this.deviceProfile.phones();
  }
}
