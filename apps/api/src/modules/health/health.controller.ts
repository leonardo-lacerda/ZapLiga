import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../infrastructure/redis/redis.service';

const withTimeout = <T>(promise: Promise<T>, ms = 2000) => Promise.race([
  promise,
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
]);

@Controller()
export class HealthController {
  constructor(private readonly db: DatabaseService, private readonly redis: RedisService) {}

  @Get('/health')
  async health() {
    // Database and Redis gate the response status: without them the API cannot
    // authenticate, serve tenant data, or coordinate the dialer, so a deploy or
    // orchestrator health check must see this as unhealthy. Waxum is reported
    // for visibility but does not fail the check — it recovers on its own and
    // failing here would make deploys flap on a slow-starting WhatsApp bridge.
    const [database, redis, waxum] = await Promise.allSettled([
      withTimeout(this.db.query('SELECT 1')),
      withTimeout(this.redis.client.ping()),
      withTimeout(fetch((process.env.WAXUM_URL ?? 'http://localhost:3451').replace(/\/$/, ''), { signal: AbortSignal.timeout(2000) }).then((r) => r.status < 500)),
    ]);
    const checks = {
      database: database.status === 'fulfilled',
      redis: redis.status === 'fulfilled',
      waxum: waxum.status === 'fulfilled',
    };
    if (!checks.database || !checks.redis) throw new ServiceUnavailableException({ ok: false, service: 'zapliga-api', checks });
    return { ok: true, service: 'zapliga-api', checks };
  }
}
