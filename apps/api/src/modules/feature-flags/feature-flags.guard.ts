import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FeatureFlagsService, TenantFeature } from './feature-flags.service';

export const FEATURE_KEY = 'zapcall_tenant_feature';
export const RequiresFeature = (feature: TenantFeature) => SetMetadata(FEATURE_KEY, feature);

@Injectable()
export class FeatureFlagGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly flags: FeatureFlagsService) {}
  async canActivate(context: ExecutionContext) {
    const feature = this.reflector.getAllAndOverride<TenantFeature>(FEATURE_KEY, [context.getHandler(), context.getClass()]);
    if (!feature) return true;
    const request = context.switchToHttp().getRequest<any>();
    await this.flags.assertEnabled(String(request.tenantId ?? request.params?.tenantId ?? ''), feature);
    return true;
  }
}
