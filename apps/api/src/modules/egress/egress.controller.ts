import { BadRequestException, Body, Controller, Delete, Get, Header, Headers, Param, Patch, Post, Query, UnauthorizedException, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser, Roles, RolesGuard } from '../auth/auth.guards';
import { EgressService } from './egress.service';
import { EgressProxyService, ProxyReport } from './egress-proxy.service';

const text = (value: unknown, field: string, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new BadRequestException(`${field} inválido`);
  return value.trim();
};

@Controller('/api/admin/egress')
@UseGuards(AuthGuard, RolesGuard)
@Roles('super_admin')
export class EgressAdminController {
  constructor(private readonly egress: EgressService, private readonly proxies: EgressProxyService) {}

  @Get('/proxies')
  listProxies() { return this.proxies.list(); }

  @Post('/proxies')
  addProxy(@Body() body: { name?: unknown; proxy?: unknown }, @CurrentUser() actor: any) {
    return this.proxies.create(actor.id, { name: text(body?.name, 'Nome', 60), proxy: text(body?.proxy, 'Proxy', 500) });
  }

  @Delete('/proxies/:id')
  removeProxy(@Param('id') id: string, @CurrentUser() actor: any) { return this.proxies.remove(actor.id, id); }

  @Get('/settings')
  settings() { return this.egress.settings(); }

  @Post('/settings')
  saveSettings(@Body() body: { clientId?: unknown; clientSecret?: unknown }, @CurrentUser() actor: any) {
    return this.egress.saveSettings(actor.id, text(body?.clientId, 'Client ID'), text(body?.clientSecret, 'Client secret', 500));
  }

  @Patch('/settings/pool')
  savePoolSettings(@Body() body: { poolEnabled?: unknown; maxNumbersPerPc?: unknown; offlineGraceSeconds?: unknown }, @CurrentUser() actor: any) {
    if (body?.poolEnabled !== undefined && typeof body.poolEnabled !== 'boolean') throw new BadRequestException('poolEnabled inválido');
    const integer = (value: unknown, field: string, min: number, max: number) => {
      if (value === undefined) return undefined;
      if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new BadRequestException(`${field} precisa ser um inteiro entre ${min} e ${max}`);
      return value as number;
    };
    return this.egress.savePoolSettings(actor.id, {
      poolEnabled: body?.poolEnabled as boolean | undefined,
      maxNumbersPerPc: integer(body?.maxNumbersPerPc, 'maxNumbersPerPc', 1, 50),
      offlineGraceSeconds: integer(body?.offlineGraceSeconds, 'offlineGraceSeconds', 30, 86400),
    });
  }

  @Get('/install-command')
  installCommand() { return this.egress.installCommand(); }

  @Get('/nodes')
  nodes() { return this.egress.nodes(); }

  @Get('/pcs')
  pcs() { return this.egress.listPcs(); }

  @Patch('/pcs/:id')
  updatePc(@Param('id') id: string, @Body() body: { name?: unknown }, @CurrentUser() actor: any) {
    return this.egress.updatePc(actor.id, id, { name: body?.name === undefined ? undefined : text(body.name, 'Nome', 60) });
  }

  @Delete('/pcs/:id')
  removePc(@Param('id') id: string, @CurrentUser() actor: any) { return this.egress.removePc(actor.id, id); }
}

// Called by the slot watchers inside the VPS (infra/egress/edge-entrypoint.sh)
// with the key they already share with the API.
@Controller('/api/internal/egress')
export class EgressInternalController {
  constructor(private readonly egress: EgressService, private readonly proxies: EgressProxyService) {}

  private authorize(authorization?: string) {
    if (!process.env.WAXUM_API_KEY || authorization !== `Bearer ${process.env.WAXUM_API_KEY}`) throw new UnauthorizedException();
  }

  // The proxy slot watcher (infra/egress/proxy-entrypoint.sh).
  @Get('/proxy-slots/:slot')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  proxySlot(@Param('slot') slot: string, @Headers('authorization') authorization?: string) {
    this.authorize(authorization);
    return this.proxies.slotConfig(slot);
  }

  @Post('/proxy-slots/:slot/report')
  proxyReport(@Param('slot') slot: string, @Body() body: Partial<ProxyReport>, @Headers('authorization') authorization?: string) {
    this.authorize(authorization);
    const bytes = (value: unknown) => (Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0);
    if (!['proxy', 'offline'].includes(String(body?.route))) throw new BadRequestException('route inválida');
    return this.proxies.report(slot, {
      route: String(body.route),
      rxBytes: bytes(body.rxBytes), txBytes: bytes(body.txBytes), udpRxBytes: bytes(body.udpRxBytes), udpTxBytes: bytes(body.udpTxBytes),
      exitIp: typeof body.exitIp === 'string' ? body.exitIp.slice(0, 64) : '',
      udpOk: body.udpOk === true,
      latencyMs: Number.isSafeInteger(body.latencyMs) ? body.latencyMs as number : null,
      error: typeof body.error === 'string' ? body.error.slice(0, 200) : '',
    });
  }

  @Get('/slots/:slot')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  slot(@Param('slot') slot: string, @Query('route') route: string, @Query('loggedIn') loggedIn: string, @Headers('authorization') authorization?: string) {
    this.authorize(authorization);
    if (!['pc', 'offline', 'idle', 'none'].includes(route)) throw new BadRequestException('route inválida');
    return this.egress.slotConfig(slot, route, loggedIn === '1');
  }
}
