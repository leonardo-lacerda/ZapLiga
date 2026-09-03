import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

const reserveScript = `
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3])
  redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[3])
  local rateWindowMs = tonumber(ARGV[8])
  local maxCallsPerWindow = tonumber(ARGV[7])
  local maxCallsPerMinute = tonumber(ARGV[9])
  local minIntervalMs = tonumber(ARGV[10])
  if maxCallsPerWindow > 0 then
    redis.call('ZREMRANGEBYSCORE', KEYS[7], '-inf', tonumber(ARGV[3]) - rateWindowMs)
    if redis.call('ZCARD', KEYS[7]) >= maxCallsPerWindow then return 0 end
  end
  if maxCallsPerMinute > 0 then
    redis.call('ZREMRANGEBYSCORE', KEYS[8], '-inf', tonumber(ARGV[3]) - 60000)
    if redis.call('ZCARD', KEYS[8]) >= maxCallsPerMinute then return 0 end
  end
  if minIntervalMs > 0 and redis.call('EXISTS', KEYS[9]) == 1 then return 0 end
  if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then return 0 end
  if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[2]) then return 0 end
  if redis.call('EXISTS', KEYS[3]) == 1 or redis.call('EXISTS', KEYS[4]) == 1 or redis.call('EXISTS', KEYS[5]) == 1 or redis.call('EXISTS', KEYS[6]) == 1 then return 0 end
  redis.call('ZADD', KEYS[1], ARGV[4], ARGV[5])
  redis.call('ZADD', KEYS[2], ARGV[4], ARGV[5])
  redis.call('SET', KEYS[3], ARGV[5], 'PX', ARGV[6])
  redis.call('SET', KEYS[4], ARGV[5], 'PX', ARGV[6])
  redis.call('SET', KEYS[5], ARGV[5], 'PX', ARGV[6])
  redis.call('SET', KEYS[6], ARGV[5], 'PX', ARGV[6])
  if maxCallsPerWindow > 0 then
    redis.call('ZADD', KEYS[7], ARGV[3], ARGV[5])
    redis.call('EXPIRE', KEYS[7], math.max(1, math.ceil(rateWindowMs / 1000) * 2))
  end
  if maxCallsPerMinute > 0 then
    redis.call('ZADD', KEYS[8], ARGV[3], ARGV[5])
    redis.call('EXPIRE', KEYS[8], 120)
  end
  if minIntervalMs > 0 then redis.call('SET', KEYS[9], ARGV[3], 'PX', minIntervalMs) end
  return 1
`;

const releaseScript = `
  redis.call('ZREM', KEYS[1], ARGV[1])
  redis.call('ZREM', KEYS[2], ARGV[1])
  for i = 3, 6 do
    if redis.call('GET', KEYS[i]) == ARGV[1] then redis.call('DEL', KEYS[i]) end
  end
  return 1
`;

const releaseLockScript = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
  return 0
`;

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  readonly client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

  async onModuleInit() { await this.client.ping(); }
  async onModuleDestroy() { await this.client.quit(); }

  async acquireLock(name: string, token: string, ttlMs: number) {
    const result = await this.client.set(name, token, 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  async releaseLock(name: string, token: string) {
    await this.client.eval(releaseLockScript, 1, name, token);
  }

  async reserve(resources: { tenantId: string; token: string; globalMax: number; numberMax: number; maxCallsPerWindow?: number; callWindowSeconds?: number; maxCallsPerMinute?: number; minSecondsBetweenCalls?: number; numberId: string; waxumSessionId: string; leadId: string; sdrId: string; ttlMs: number }) {
    const now = Date.now();
    const expires = now + resources.ttlMs;
    const tenantPrefix = `zapcall:tenant:${resources.tenantId}`;
    const globalPrefix = 'zapcall:global';
    const keys = [`${tenantPrefix}:active:global`, `${globalPrefix}:active:number:${resources.numberId}`, `${tenantPrefix}:lock:lead:${resources.leadId}`, `${tenantPrefix}:lock:sdr:${resources.sdrId}`, `${globalPrefix}:lock:number:${resources.numberId}`, `${globalPrefix}:lock:session:${resources.waxumSessionId}`, `${globalPrefix}:rate:number:${resources.numberId}`, `${tenantPrefix}:rate:minute`, `${tenantPrefix}:lock:dialer-pacing`];
    const maxCallsPerWindow = Math.max(1, Number(resources.maxCallsPerWindow ?? 3) || 3);
    const callWindowSeconds = Math.max(60, Number(resources.callWindowSeconds ?? 180) || 180);
    const maxCallsPerMinute = Math.max(1, Number(resources.maxCallsPerMinute ?? 6) || 6);
    const minSecondsBetweenCalls = Math.max(0, Number(resources.minSecondsBetweenCalls ?? 10) || 0);
    const result = await this.client.eval(reserveScript, keys.length, ...keys, resources.globalMax, resources.numberMax, now, expires, resources.token, resources.ttlMs, maxCallsPerWindow, callWindowSeconds * 1000, maxCallsPerMinute, minSecondsBetweenCalls * 1000);
    return Number(result) === 1;
  }

  async release(resources: { tenantId: string; token: string; numberId: string; waxumSessionId: string; leadId: string; sdrId: string }) {
    const tenantPrefix = `zapcall:tenant:${resources.tenantId}`;
    const globalPrefix = 'zapcall:global';
    const keys = [`${tenantPrefix}:active:global`, `${globalPrefix}:active:number:${resources.numberId}`, `${tenantPrefix}:lock:lead:${resources.leadId}`, `${tenantPrefix}:lock:sdr:${resources.sdrId}`, `${globalPrefix}:lock:number:${resources.numberId}`, `${globalPrefix}:lock:session:${resources.waxumSessionId}`];
    await this.client.eval(releaseScript, keys.length, ...keys, resources.token);
  }

  private metricKey(name: string) {
    const safe = name.toLowerCase().replace(/[^a-z0-9_:]/g, '_');
    return `zapcall:metrics:${safe}`;
  }

  async incrementMetric(name: string, amount = 1) {
    await this.client.incrby(this.metricKey(`counter:${name}`), amount).catch(() => undefined);
  }

  async observeMetric(name: string, durationMs: number) {
    const key = this.metricKey(`timing:${name}`);
    await this.client.multi().hincrby(key, 'count', 1).hincrbyfloat(key, 'sum_ms', Math.max(0, durationMs)).exec().catch(() => undefined);
  }

  async metricsSnapshot() {
    const counters: Record<string, number> = {};
    const timings: Record<string, { count: number; sumMs: number }> = {};
    let cursor = '0';
    do {
      const [next, keys] = await this.client.scan(cursor, 'MATCH', 'zapcall:metrics:*', 'COUNT', 100);
      cursor = next;
      for (const key of keys) {
        const name = key.replace('zapcall:metrics:', '');
        if (name.startsWith('counter:')) counters[name.slice(8)] = Number(await this.client.get(key) ?? 0);
        if (name.startsWith('timing:')) {
          const values = await this.client.hmget(key, 'count', 'sum_ms');
          timings[name.slice(7)] = { count: Number(values[0] ?? 0), sumMs: Number(values[1] ?? 0) };
        }
      }
    } while (cursor !== '0');
    return { counters, timings };
  }
}
