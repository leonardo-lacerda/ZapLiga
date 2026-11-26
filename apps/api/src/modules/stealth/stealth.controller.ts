import { BadRequestException, Body, Controller, Get, Patch, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { SetStealthDto } from './dto/set-stealth.dto';
import { StealthService } from './stealth.service';

const DEFAULT_COHORT_DAYS = 28;
const MAX_COHORT_DAYS = 90;

/** Camouflage per line (docs/stealth-profile.md): an experiment run by the ZapLiga team. */
@Controller()
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
export class StealthController {
  constructor(private readonly stealth: StealthService) {}

  @Roles('super_admin')
  @Patch(['/api/numbers/:id/stealth', '/api/tenants/:tenantId/numbers/:id/stealth'])
  set(@Param('id') id: string, @Body() body: SetStealthDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    return this.stealth.setEnabled(tenantId, user.id, id, body.enabled);
  }

  @Roles('super_admin')
  @Get(['/api/stealth/cohorts', '/api/tenants/:tenantId/stealth/cohorts'])
  cohorts(@Query('days') days: string | undefined, @CurrentTenant() tenantId: string) {
    const window = days === undefined ? DEFAULT_COHORT_DAYS : Number(days);
    if (!Number.isInteger(window) || window < 1 || window > MAX_COHORT_DAYS) throw new BadRequestException(`days deve ser um inteiro de 1 a ${MAX_COHORT_DAYS}`);
    return this.stealth.cohorts(tenantId, window);
  }
}
