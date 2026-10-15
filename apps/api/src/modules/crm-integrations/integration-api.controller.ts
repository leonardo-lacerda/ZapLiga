import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { NumbersService } from '../numbers/numbers.service';
import { CreateDialIntentDto, EnsureAgentDto, HandshakeDto, IntegrationCreateNumberDto, IntegrationSuppressionDto, IntegrationUpdateNumberDto, IntegrationWrapUpDto } from './dto/crm-integration.dto';
import { CurrentIntegration, IntegrationKeyGuard, RequiresScope } from './crm-integration.guard';
import { CrmIntegration, CrmIntegrationsService } from './crm-integrations.service';
import { IntegrationAgentsService } from './integration-agents.service';
import { IntegrationCallsService } from './integration-calls.service';

/**
 * Server-to-server API for CRM integrations (contract v1). Authenticated by the integration key;
 * the key alone determines the tenant. Documented in docs/integracao-franco.md.
 */
@Controller('/api/v1/integrations')
@UseGuards(IntegrationKeyGuard)
export class IntegrationApiController {
  constructor(private readonly integrations: CrmIntegrationsService, private readonly agents: IntegrationAgentsService, private readonly calls: IntegrationCallsService, private readonly numbers: NumbersService) {}

  @Get('/me')
  me(@CurrentIntegration() integration: CrmIntegration) { return this.integrations.me(integration); }

  @Post('/handshake')
  @RequiresScope('webhooks')
  handshake(@CurrentIntegration() integration: CrmIntegration, @Body() body: HandshakeDto) { return this.integrations.handshake(integration, body); }

  @Get('/catalog')
  catalog() { return this.calls.catalog(); }

  @Get('/numbers')
  @RequiresScope('numbers:read')
  lines(@CurrentIntegration() integration: CrmIntegration) { return this.calls.lines(integration); }

  @Post('/numbers')
  @RequiresScope('numbers:write')
  async createLine(@CurrentIntegration() integration: CrmIntegration, @Body() body: IntegrationCreateNumberDto) {
    return this.calls.lineView(await this.numbers.create(integration.tenant_id, null, body));
  }

  @Get('/numbers/:id/qr')
  @RequiresScope('numbers:write')
  qr(@CurrentIntegration() integration: CrmIntegration, @Param('id') id: string) { return this.numbers.qr(integration.tenant_id, id); }

  @Post('/numbers/:id/reconnect')
  @RequiresScope('numbers:write')
  reconnect(@CurrentIntegration() integration: CrmIntegration, @Param('id') id: string) { return this.numbers.reconnect(integration.tenant_id, null, id); }

  @Patch('/numbers/:id/settings')
  @RequiresScope('numbers:write')
  async lineSettings(@CurrentIntegration() integration: CrmIntegration, @Param('id') id: string, @Body() body: IntegrationUpdateNumberDto) {
    return this.calls.lineView(await this.numbers.updateSettings(integration.tenant_id, null, id, body));
  }

  @Delete('/numbers/:id')
  @RequiresScope('numbers:write')
  removeLine(@CurrentIntegration() integration: CrmIntegration, @Param('id') id: string) { return this.numbers.remove(integration.tenant_id, null, id); }

  @Get('/agents')
  @RequiresScope('agents')
  listAgents(@CurrentIntegration() integration: CrmIntegration) { return this.agents.list(integration); }

  @Post('/agents/ensure')
  @RequiresScope('agents')
  ensureAgent(@CurrentIntegration() integration: CrmIntegration, @Body() body: EnsureAgentDto) { return this.agents.ensure(integration, body); }

  @Delete('/agents/:sdrId/link')
  @RequiresScope('agents')
  unlinkAgent(@CurrentIntegration() integration: CrmIntegration, @Param('sdrId') sdrId: string) { return this.agents.unlink(integration, sdrId); }

  @Post('/agents/:sdrId/station-ticket')
  @RequiresScope('calls')
  stationTicket(@CurrentIntegration() integration: CrmIntegration, @Param('sdrId') sdrId: string) { return this.agents.stationTicket(integration, sdrId); }

  @Post('/dial-intents')
  @RequiresScope('calls')
  dialIntent(@CurrentIntegration() integration: CrmIntegration, @Body() body: CreateDialIntentDto) { return this.calls.createDialIntent(integration, body); }

  @Get('/calls')
  @RequiresScope('calls')
  listCalls(@CurrentIntegration() integration: CrmIntegration, @Query('external_call_id') externalCallId?: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.calls.list(integration, { externalCallId, limit: Number(limit), offset: Number(offset) });
  }

  @Get('/calls/:id')
  @RequiresScope('calls')
  call(@CurrentIntegration() integration: CrmIntegration, @Param('id') id: string) { return this.calls.get(integration, id); }

  @Post('/calls/:id/hangup')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequiresScope('calls')
  hangup(@CurrentIntegration() integration: CrmIntegration, @Param('id') id: string) { return this.calls.hangup(integration, id); }

  @Post('/calls/:id/wrap-up')
  @RequiresScope('calls')
  wrapUp(@CurrentIntegration() integration: CrmIntegration, @Param('id') id: string, @Body() body: IntegrationWrapUpDto) { return this.calls.wrapUp(integration, id, body); }

  @Post('/suppressions')
  @RequiresScope('calls')
  suppress(@CurrentIntegration() integration: CrmIntegration, @Body() body: IntegrationSuppressionDto) { return this.calls.suppress(integration, body); }
}
