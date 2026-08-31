import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, finalize, tap } from 'rxjs';
import { RedisService } from './redis/redis.service';

const journeyFor = (path: string) => {
  if (path.startsWith('/api/auth/')) return 'auth';
  if (path.includes('/privacy/')) return 'privacy';
  if (path.includes('/callbacks')) return 'callbacks';
  if (path.includes('/dialer/') || path.includes('/calls/')) return 'calling';
  if (path.includes('/invitations')) return 'invitations';
  return undefined;
};

@Injectable()
export class OperationalMetricsInterceptor implements NestInterceptor {
  constructor(private readonly redis: RedisService) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<any>();
    const response = http.getResponse<any>();
    const journey = journeyFor(String(request.route?.path ?? request.path ?? ''));
    if (!journey) return next.handle();
    const startedAt = Date.now();
    let failed = false;
    return next.handle().pipe(tap({ error: () => { failed = true; } }), finalize(() => {
      void this.redis.observeMetric(`journey_${journey}`, Date.now() - startedAt);
      if (failed || Number(response.statusCode) >= 400) void this.redis.incrementMetric(`journey_${journey}_failures_total`);
    }));
  }
}
