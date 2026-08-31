import { Controller, Get, Header, Headers, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
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

  @Get('/internal/metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async metrics(@Headers('authorization') authorization?: string) {
    const token = process.env.METRICS_TOKEN;
    if (!token || authorization !== `Bearer ${token}`) throw new UnauthorizedException('Token de metricas invalido');
    const [snapshot, overdue] = await Promise.all([
      this.redis.metricsSnapshot(),
      this.db.query(`SELECT count(*)::int AS total FROM lead_callbacks WHERE status IN ('pending','due') AND due_at < now()`),
    ]);
    const lines: string[] = ['# ZapLiga operational metrics'];
    for (const [name, value] of Object.entries(snapshot.counters)) lines.push(`# TYPE zapliga_${name} counter`, `zapliga_${name} ${value}`);
    for (const [name, value] of Object.entries(snapshot.timings)) lines.push(`# TYPE zapliga_${name}_milliseconds summary`, `zapliga_${name}_milliseconds_count ${value.count}`, `zapliga_${name}_milliseconds_sum ${value.sumMs}`);
    lines.push('# TYPE zapliga_callbacks_overdue gauge', `zapliga_callbacks_overdue ${Number(overdue.rows[0]?.total ?? 0)}`);
    return `${lines.join('\n')}\n`;
  }
}
