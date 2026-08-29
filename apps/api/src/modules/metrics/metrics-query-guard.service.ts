import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { RedisService } from '../../infrastructure/redis/redis.service';

const CACHE_TTL_SECONDS = 20;
const RATE_LIMIT_WINDOW_SECONDS = 10;
const RATE_LIMIT_MAX_REQUESTS = 30;

/**
 * "Adicionar cache e limites" (plano seção 13, Fase 3) para os endpoints
 * agregados de métricas: cache curto para absorver filtros idênticos
 * (múltiplos widgets, atualização automática) e um limite de consultas por
 * usuário/tenant para consultas pesadas (plano seção 7.3).
 */
@Injectable()
export class MetricsQueryGuardService {
  constructor(private readonly redis: RedisService) {}

  async withCache<T>(cacheKey: string, compute: () => Promise<T>): Promise<T> {
    const key = `zapcall:metrics:cache:${cacheKey}`;
    const cached = await this.redis.client.get(key).catch(() => null);
    if (cached) {
      try { return JSON.parse(cached) as T; } catch { /* cache corrompido — recalcula abaixo */ }
    }
    const value = await compute();
    await this.redis.client.set(key, JSON.stringify(value), 'EX', CACHE_TTL_SECONDS).catch(() => undefined);
    return value;
  }

  async enforceRateLimit(tenantId: string, userId: string): Promise<void> {
    const key = `zapcall:metrics:rl:${tenantId}:${userId}`;
    const count = await this.redis.client.incr(key).catch(() => 0);
    if (count === 1) await this.redis.client.expire(key, RATE_LIMIT_WINDOW_SECONDS).catch(() => undefined);
    if (count > RATE_LIMIT_MAX_REQUESTS) {
      throw new HttpException('Muitas consultas de métricas em sequência; aguarde alguns segundos.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}
