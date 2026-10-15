import { CanActivate, ExecutionContext, ForbiddenException, HttpException, HttpStatus, Injectable, SetMetadata, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { CrmIntegration, CrmIntegrationsService, IntegrationScope } from './crm-integrations.service';

export const INTEGRATION_SCOPE_KEY = 'zapliga_integration_scope';
export const RequiresScope = (scope: IntegrationScope) => SetMetadata(INTEGRATION_SCOPE_KEY, scope);

export const CurrentIntegration = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<{ integration?: CrmIntegration }>();
  return request.integration;
});

const rateLimitPerMinute = () => Math.max(30, Number(process.env.CRM_INTEGRATION_RATE_LIMIT_PER_MINUTE) || 600);

/**
 * Authenticates the server-to-server CRM API by integration key. The key alone decides the
 * tenant: no route or header can point it elsewhere.
 */
@Injectable()
export class IntegrationKeyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly integrations: CrmIntegrationsService, private readonly redis: RedisService, private readonly flags: FeatureFlagsService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<any>();
    const header = String(request.headers.authorization ?? '');
    const apiKey = (header.startsWith('Bearer ') ? header.slice(7) : String(request.headers['x-zapliga-api-key'] ?? '')).trim();
    if (!apiKey) throw new UnauthorizedException('API key ausente');
    const integration = await this.integrations.authenticate(apiKey);
    if (!integration) {
      await this.redis.incrementMetric('crm_integration_auth_failures_total').catch(() => undefined);
      throw new UnauthorizedException('API key inválida ou revogada');
    }
    const window = Math.floor(Date.now() / 60_000);
    const rateKey = `zapcall:crm-integration:${integration.id}:rate:${window}`;
    const count = await this.redis.client.incr(rateKey);
    if (count === 1) await this.redis.client.expire(rateKey, 70);
    if (count > rateLimitPerMinute()) throw new HttpException({ code: 'rate_limited', message: 'Limite de requisições da integração excedido', retry_after_seconds: 60 - Math.floor((Date.now() % 60_000) / 1000) }, HttpStatus.TOO_MANY_REQUESTS);
    const scope = this.reflector.getAllAndOverride<IntegrationScope | undefined>(INTEGRATION_SCOPE_KEY, [context.getHandler(), context.getClass()]);
    if (scope && !integration.scopes.includes(scope)) throw new ForbiddenException({ code: 'missing_scope', message: `A chave não tem o escopo ${scope}` });
    await this.flags.assertEnabled(integration.tenant_id, 'crm_integration', request.method);
    request.integration = integration;
    request.tenantId = integration.tenant_id;
    void this.integrations.touch(integration).catch(() => undefined);
    return true;
  }
}
