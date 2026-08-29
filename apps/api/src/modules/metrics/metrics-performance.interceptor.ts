import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { tap } from 'rxjs/operators';

const SLOW_QUERY_WARN_MS = 800;

/**
 * "Monitorar p95 e custo das consultas" (plano seção 13, Fase 8, item 5) e
 * seção 12.1/12.2: duração de cada consulta de métricas, tenant e endpoint —
 * sem logar filtros ou resultado (dados potencialmente sensíveis, plano
 * seção 12.1: "sem expor dados desnecessários").
 * `request.tenantId` já está resolvido neste ponto — `TenantMembershipGuard`
 * roda antes de qualquer interceptor no pipeline do Nest.
 */
@Injectable()
export class MetricsPerformanceInterceptor implements NestInterceptor {
  private readonly logger = new Logger('MetricsPerformance');

  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest();
    const start = process.hrtime.bigint();
    return next.handle().pipe(
      tap(() => {
        const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
        const route = request.route?.path ?? request.path;
        const tenantId = request.tenantId ?? '-';
        const line = `${request.method} ${route} tenant=${tenantId} ${durationMs.toFixed(1)}ms`;
        if (durationMs > SLOW_QUERY_WARN_MS) this.logger.warn(`slow query: ${line}`);
        else this.logger.debug(line);
      }),
    );
  }
}
