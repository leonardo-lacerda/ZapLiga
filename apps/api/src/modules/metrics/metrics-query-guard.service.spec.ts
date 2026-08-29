import { HttpException } from '@nestjs/common';
import { MetricsQueryGuardService } from './metrics-query-guard.service';

describe('MetricsQueryGuardService', () => {
  const get = jest.fn();
  const set = jest.fn();
  const incr = jest.fn();
  const expire = jest.fn();
  const service = new MetricsQueryGuardService({ client: { get, set, incr, expire } } as any);

  beforeEach(() => {
    get.mockReset().mockResolvedValue(null);
    set.mockReset().mockResolvedValue('OK');
    incr.mockReset().mockResolvedValue(1);
    expire.mockReset().mockResolvedValue(1);
  });

  describe('withCache', () => {
    it('computes and caches on a miss', async () => {
      get.mockResolvedValue(null);
      const compute = jest.fn().mockResolvedValue({ value: 42 });

      const result = await service.withCache('key-1', compute);

      expect(result).toEqual({ value: 42 });
      expect(compute).toHaveBeenCalledTimes(1);
      expect(set).toHaveBeenCalledWith(expect.stringContaining('key-1'), JSON.stringify({ value: 42 }), 'EX', expect.any(Number));
    });

    it('returns the cached value without recomputing on a hit', async () => {
      get.mockResolvedValue(JSON.stringify({ value: 7 }));
      const compute = jest.fn().mockResolvedValue({ value: 999 });

      const result = await service.withCache('key-1', compute);

      expect(result).toEqual({ value: 7 });
      expect(compute).not.toHaveBeenCalled();
    });

    it('falls back to compute when the cache read fails, instead of breaking the endpoint', async () => {
      get.mockRejectedValue(new Error('redis down'));
      const compute = jest.fn().mockResolvedValue({ value: 1 });

      await expect(service.withCache('key-1', compute)).resolves.toEqual({ value: 1 });
    });
  });

  describe('enforceRateLimit', () => {
    it('allows requests under the limit', async () => {
      incr.mockResolvedValue(5);
      await expect(service.enforceRateLimit('tenant-1', 'user-1')).resolves.toBeUndefined();
    });

    it('sets the window expiry only on the first request', async () => {
      incr.mockResolvedValue(1);
      await service.enforceRateLimit('tenant-1', 'user-1');
      expect(expire).toHaveBeenCalledTimes(1);
    });

    it('rejects with 429 once the window limit is exceeded', async () => {
      incr.mockResolvedValue(31);
      await expect(service.enforceRateLimit('tenant-1', 'user-1')).rejects.toBeInstanceOf(HttpException);
    });
  });
});
