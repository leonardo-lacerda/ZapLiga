import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

const reserveScript = `
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3])
  redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[3])
  if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then return 0 end
  if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[2]) then return 0 end
  if redis.call('EXISTS', KEYS[3]) == 1 or redis.call('EXISTS', KEYS[4]) == 1 or redis.call('EXISTS', KEYS[5]) == 1 then return 0 end
  redis.call('ZADD', KEYS[1], ARGV[4], ARGV[5])
  redis.call('ZADD', KEYS[2], ARGV[4], ARGV[5])
  redis.call('SET', KEYS[3], ARGV[5], 'PX', ARGV[6])
  redis.call('SET', KEYS[4], ARGV[5], 'PX', ARGV[6])
  redis.call('SET', KEYS[5], ARGV[5], 'PX', ARGV[6])
  return 1
`;

const releaseScript = `
  redis.call('ZREM', KEYS[1], ARGV[1])
  redis.call('ZREM', KEYS[2], ARGV[1])
  for i = 3, 5 do
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

  async reserve(resources: { tenantId: string; token: string; globalMax: number; numberMax: number; numberId: string; leadId: string; sdrId: string; ttlMs: number }) {
    const now = Date.now();
    const expires = now + resources.ttlMs;
    const prefix = `zapcall:tenant:${resources.tenantId}`;
    const keys = [`${prefix}:active:global`, `${prefix}:active:number:${resources.numberId}`, `${prefix}:lock:lead:${resources.leadId}`, `${prefix}:lock:sdr:${resources.sdrId}`, `${prefix}:lock:number:${resources.numberId}`];
    const result = await this.client.eval(reserveScript, keys.length, ...keys, resources.globalMax, resources.numberMax, now, expires, resources.token, resources.ttlMs);
    return Number(result) === 1;
  }

  async release(resources: { tenantId: string; token: string; numberId: string; leadId: string; sdrId: string }) {
    const prefix = `zapcall:tenant:${resources.tenantId}`;
    const keys = [`${prefix}:active:global`, `${prefix}:active:number:${resources.numberId}`, `${prefix}:lock:lead:${resources.leadId}`, `${prefix}:lock:sdr:${resources.sdrId}`, `${prefix}:lock:number:${resources.numberId}`];
    await this.client.eval(releaseScript, keys.length, ...keys, resources.token);
  }
}
