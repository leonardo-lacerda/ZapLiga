import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { McpKeysService } from './mcp-keys.service';

const rateLimitPerMinute = () => Math.max(30, Number(process.env.MCP_RATE_LIMIT_PER_MINUTE) || 240);

/**
 * Authenticates POST /mcp by MCP key (`Authorization: Bearer zpl_mcp_...`). The key alone
 * decides the tenant and the acting user; the tenant needs the provisioning feature on.
 */
@Injectable()
export class McpKeyGuard implements CanActivate {
  constructor(private readonly keys: McpKeysService, private readonly redis: RedisService, private readonly flags: FeatureFlagsService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<any>();
    const header = String(request.headers.authorization ?? '');
    const apiKey = (header.startsWith('Bearer ') ? header.slice(7) : '').trim();
    if (!apiKey) throw new UnauthorizedException('Chave do MCP ausente (Authorization: Bearer ...)');
    const key = await this.keys.authenticate(apiKey);
    if (!key) {
      await this.redis.incrementMetric('mcp_auth_failures_total').catch(() => undefined);
      throw new UnauthorizedException('Chave do MCP inválida ou revogada');
    }
    const window = Math.floor(Date.now() / 60_000);
    const rateKey = `zapcall:mcp-key:${key.id}:rate:${window}`;
    const count = await this.redis.client.incr(rateKey);
    if (count === 1) await this.redis.client.expire(rateKey, 70);
    if (count > rateLimitPerMinute()) throw new HttpException({ code: 'rate_limited', message: 'Limite de chamadas do MCP excedido; tente em 1 minuto.' }, HttpStatus.TOO_MANY_REQUESTS);
    await this.flags.assertEnabled(key.tenant_id, 'whatsapp_provisioning', 'POST');
    request.mcpKey = key;
    request.tenantId = key.tenant_id;
    void this.keys.touch(key).catch(() => undefined);
    return true;
  }
}
