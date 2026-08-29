import { BadRequestException, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { daysBetweenDateStrs } from './metrics.formulas';
import { MetricsRepository } from './metrics.repository';

const MAX_REPROCESS_DAYS = 400;

/**
 * Reprocessamento manual do rollup diário (plano seção 13, Fase 8, item 2)
 * — para corrigir um intervalo específico (ex.: depois de editar
 * manualmente um `call_result` antigo, ou se um gatilho falhar por algum
 * motivo). O recálculo em si (`refresh_metrics_daily_rollup`) já é
 * idempotente por natureza — sempre recomputa do zero, nunca soma — então
 * chamar isto de novo para o mesmo intervalo é seguro.
 */
@Injectable()
export class MetricsRollupService {
  constructor(private readonly repo: MetricsRepository, private readonly audit: AuditService) {}

  async reprocess(tenantId: string, userId: string, from: string, to: string): Promise<{ daysProcessed: number }> {
    if (from > to) throw new BadRequestException('"from" não pode ser posterior a "to"');
    const days = daysBetweenDateStrs(from, to) + 1;
    if (days > MAX_REPROCESS_DAYS) throw new BadRequestException(`O intervalo máximo por reprocessamento é de ${MAX_REPROCESS_DAYS} dias`);

    const result = await this.repo.reprocessDailyRollup(tenantId, from, to);
    await this.audit.record({
      actorUserId: userId, tenantId, action: 'metrics_rollup.reprocessed', entityType: 'metrics_daily_rollup',
      metadata: { from, to, daysProcessed: result.daysProcessed },
    });
    return result;
  }
}
