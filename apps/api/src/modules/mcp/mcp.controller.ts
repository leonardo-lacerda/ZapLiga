import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { IsArray, IsIn, IsOptional, IsString, Length } from 'class-validator';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { FeatureFlagGuard, RequiresFeature } from '../feature-flags/feature-flags.guard';
import { MCP_SCOPES, McpKeysService } from './mcp-keys.service';
import { McpKeyGuard } from './mcp.guard';
import { McpToolsFactory } from './mcp.tools';

export class CreateMcpKeyDto {
  @IsString() @Length(2, 80) name!: string;
  @IsOptional() @IsArray() @IsIn(MCP_SCOPES as unknown as string[], { each: true }) scopes?: string[];
}

/**
 * The ZapLiga MCP (docs/mcp.md): Claude drives phones, registrations and lines through
 * `POST /api/mcp` (Streamable HTTP, stateless: a fresh server per request, so api-a and api-b
 * answer alike). The key in `Authorization: Bearer` decides the tenant, the user and the tools.
 */
@Controller('/api/mcp')
export class McpController {
  constructor(private readonly tools: McpToolsFactory) {}

  @Post()
  @UseGuards(McpKeyGuard)
  async handle(@Req() request: any, @Res() response: any) {
    const server = this.tools.build(request.mcpKey);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  }

  // Stateless server: no SSE stream to open and no session to end.
  @Get()
  @Delete()
  methodNotAllowed(@Res() response: any) {
    response.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Use POST.' }, id: null });
  }
}

/** Where a leader creates and revokes MCP keys (Cadastrar número → Chave para o Claude). */
@Controller('/api/tenants/:tenantId/provisioning/mcp-keys')
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard, FeatureFlagGuard)
@RequiresFeature('whatsapp_provisioning')
@Roles('leader', 'super_admin')
export class McpKeysController {
  constructor(private readonly keys: McpKeysService) {}

  @Get()
  list(@CurrentTenant() tenantId: string) { return this.keys.list(tenantId); }

  @Post()
  create(@Body() body: CreateMcpKeyDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.keys.create(tenantId, user.id, body); }

  @Post('/:id/revoke')
  @HttpCode(200)
  revoke(@Param('id') id: string, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.keys.revoke(tenantId, user.id, id); }
}
