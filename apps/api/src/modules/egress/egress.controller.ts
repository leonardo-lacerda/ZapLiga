import { BadRequestException, Body, Controller, Delete, Get, Header, Headers, Param, Patch, Post, Query, UnauthorizedException, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser, Roles, RolesGuard } from '../auth/auth.guards';
import { EgressService } from './egress.service';

const text = (value: unknown, field: string, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new BadRequestException(`${field} inválido`);
  return value.trim();
};

@Controller('/api/admin/egress')
@UseGuards(AuthGuard, RolesGuard)
@Roles('super_admin')
export class EgressAdminController {
  constructor(private readonly egress: EgressService) {}

  @Get('/settings')
  settings() { return this.egress.settings(); }

  @Post('/settings')
  saveSettings(@Body() body: { clientId?: unknown; clientSecret?: unknown }, @CurrentUser() actor: any) {
    return this.egress.saveSettings(actor.id, text(body?.clientId, 'Client ID'), text(body?.clientSecret, 'Client secret', 500));
  }

  @Get('/nodes')
  nodes() { return this.egress.nodes(); }

  @Get('/pcs')
  pcs() { return this.egress.listPcs(); }

  @Post('/pcs')
  addPc(@Body() body: { name?: unknown }, @CurrentUser() actor: any) { return this.egress.addPc(actor.id, text(body?.name, 'Nome', 60)); }

  @Post('/pcs/:id/install-command')
  installCommand(@Param('id') id: string) { return this.egress.installCommand(id); }

  @Patch('/pcs/:id')
  updatePc(@Param('id') id: string, @Body() body: { name?: unknown; fallback?: unknown }, @CurrentUser() actor: any) {
    if (body?.fallback !== undefined && body.fallback !== 'offline' && body.fallback !== 'vps') throw new BadRequestException('fallback precisa ser offline ou vps');
    return this.egress.updatePc(actor.id, id, { name: body?.name === undefined ? undefined : text(body.name, 'Nome', 60), fallback: body?.fallback as 'offline' | 'vps' | undefined });
  }

  @Delete('/pcs/:id')
  removePc(@Param('id') id: string, @CurrentUser() actor: any) { return this.egress.removePc(actor.id, id); }
}

// Called by the slot watchers inside the VPS (infra/egress/edge-entrypoint.sh)
// with the key they already share with the API.
@Controller('/api/internal/egress')
export class EgressInternalController {
  constructor(private readonly egress: EgressService) {}

  @Get('/slots/:slot')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  slot(@Param('slot') slot: string, @Query('route') route: string, @Query('loggedIn') loggedIn: string, @Headers('authorization') authorization?: string) {
    if (!process.env.WAXUM_API_KEY || authorization !== `Bearer ${process.env.WAXUM_API_KEY}`) throw new UnauthorizedException();
    if (!['pc', 'offline', 'vps', 'idle', 'none'].includes(route)) throw new BadRequestException('route inválida');
    return this.egress.slotConfig(slot, route, loggedIn === '1');
  }
}
