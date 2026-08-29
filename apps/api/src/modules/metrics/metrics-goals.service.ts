import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { CreateGoalDto } from './dto/create-goal.dto';
import { UpdateGoalDto } from './dto/update-goal.dto';
import { DEFAULT_TENANT_TIMEZONE, GOAL_METRIC_CATALOG, GoalMetric } from './metrics.definitions';
import { answerRate, civilDateInTimezone, dayRangeInTimezone } from './metrics.formulas';
import { computeGoalProgress, GoalProgress } from './metrics-goals.progress';
import { GoalRow, MetricsGoalsRepository } from './metrics-goals.repository';
import { CallFilters, MetricsRepository } from './metrics.repository';

export type GoalResponse = {
  id: string;
  scope: GoalRow['scope'];
  scopeId: string | null;
  scopeName: string | null;
  metric: GoalMetric;
  metricLabel: string;
  valueType: GoalRow['value_type'];
  targetValue: number;
  periodFrom: string;
  periodTo: string;
  status: GoalRow['status'];
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  frozenAt: string | null;
  supersededBy: string | null;
  progress: GoalProgress;
};

function filtersForGoal(goal: GoalRow): CallFilters {
  if (goal.scope === 'sdr' && goal.scope_id) return { sdrIds: [goal.scope_id] };
  if (goal.scope === 'folder' && goal.scope_id) return { folderIds: [goal.scope_id] };
  return {};
}

@Injectable()
export class MetricsGoalsService {
  constructor(
    private readonly goalsRepo: MetricsGoalsRepository,
    private readonly metricsRepo: MetricsRepository,
    private readonly audit: AuditService,
  ) {}

  private async computeActual(tenantId: string, goal: GoalRow, timezone: string): Promise<number> {
    const { startUtc } = dayRangeInTimezone(goal.period_from, timezone);
    const { endUtc } = dayRangeInTimezone(goal.period_to, timezone);
    const filters = filtersForGoal(goal);
    if (goal.metric === 'stage_advances' || goal.metric === 'conversions') {
      const counts = await this.metricsRepo.funnelCounts(tenantId, startUtc, endUtc, filters);
      return goal.metric === 'stage_advances' ? counts.leadsAdvanced : counts.leadsConverted;
    }
    const aggregates = await this.metricsRepo.callAggregates(tenantId, startUtc, endUtc, filters);
    if (goal.metric === 'calls_made') return aggregates.callsMade;
    if (goal.metric === 'leads_worked') return aggregates.uniqueLeadsWorked;
    if (goal.metric === 'answer_rate') return answerRate(aggregates.callsAnswered, aggregates.callsMade);
    if (goal.metric === 'positive_results') return aggregates.positiveResults;
    return aggregates.connectedSeconds;
  }

  private async toResponse(tenantId: string, goal: GoalRow, timezone: string, today: string): Promise<GoalResponse> {
    const actual = await this.computeActual(tenantId, goal, timezone);
    const progress = computeGoalProgress(Number(goal.target_value), actual, goal.period_from, goal.period_to, today);
    return {
      id: goal.id,
      scope: goal.scope,
      scopeId: goal.scope_id,
      scopeName: goal.scope_name ?? null,
      metric: goal.metric,
      metricLabel: GOAL_METRIC_CATALOG[goal.metric].label,
      valueType: goal.value_type,
      targetValue: Number(goal.target_value),
      periodFrom: goal.period_from,
      periodTo: goal.period_to,
      status: goal.status,
      createdBy: goal.created_by,
      createdByName: goal.created_by_name ?? null,
      createdAt: goal.created_at,
      updatedAt: goal.updated_at,
      frozenAt: goal.frozen_at,
      supersededBy: goal.superseded_by,
      progress,
    };
  }

  async list(tenantId: string, filters: { status?: string; scope?: string; scopeId?: string }): Promise<GoalResponse[]> {
    const timezone = (await this.metricsRepo.tenantTimezone(tenantId)) || DEFAULT_TENANT_TIMEZONE;
    const today = civilDateInTimezone(new Date(), timezone);
    const rows = await this.goalsRepo.list(tenantId, filters);
    return Promise.all(rows.map((row) => this.toResponse(tenantId, row, timezone, today)));
  }

  private async validateScope(tenantId: string, dto: CreateGoalDto) {
    if (dto.scope === 'organization') {
      if (dto.scopeId) throw new BadRequestException('scopeId não deve ser informado para escopo "organization"');
      return null;
    }
    if (!dto.scopeId) throw new BadRequestException('scopeId é obrigatório para escopos "sdr" e "folder"');
    const exists = dto.scope === 'sdr' ? await this.goalsRepo.sdrExists(tenantId, dto.scopeId) : await this.goalsRepo.folderExists(tenantId, dto.scopeId);
    if (!exists) throw new BadRequestException(dto.scope === 'sdr' ? 'SDR não encontrado' : 'Pasta não encontrada');
    return dto.scopeId;
  }

  async create(tenantId: string, userId: string, dto: CreateGoalDto): Promise<GoalResponse> {
    if (dto.periodFrom > dto.periodTo) throw new BadRequestException('periodFrom não pode ser posterior a periodTo');
    const scopeId = await this.validateScope(tenantId, dto);
    const id = randomUUID();
    try {
      await this.goalsRepo.insert({ id, tenantId, scope: dto.scope, scopeId, metric: dto.metric, valueType: dto.valueType, targetValue: dto.targetValue, periodFrom: dto.periodFrom, periodTo: dto.periodTo, createdBy: userId });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new ConflictException('Já existe uma meta ativa para este escopo e métrica — edite a meta existente em vez de criar outra');
      throw error;
    }
    await this.audit.record({ actorUserId: userId, tenantId, action: 'metrics_goal.created', entityType: 'metric_goal', entityId: id, metadata: { scope: dto.scope, scopeId, metric: dto.metric, targetValue: dto.targetValue, periodFrom: dto.periodFrom, periodTo: dto.periodTo } });
    const timezone = (await this.metricsRepo.tenantTimezone(tenantId)) || DEFAULT_TENANT_TIMEZONE;
    return this.toResponse(tenantId, await this.goalsRepo.findById(tenantId, id) as GoalRow, timezone, civilDateInTimezone(new Date(), timezone));
  }

  async update(tenantId: string, userId: string, id: string, dto: UpdateGoalDto): Promise<GoalResponse> {
    const periodFrom = dto.periodFrom;
    const periodTo = dto.periodTo;
    if (periodFrom && periodTo && periodFrom > periodTo) throw new BadRequestException('periodFrom não pode ser posterior a periodTo');
    const newId = randomUUID();
    await this.goalsRepo.transaction(async (client) => {
      const current = await this.goalsRepo.findActiveForUpdate(client, tenantId, id);
      if (!current) throw new NotFoundException('Meta ativa não encontrada');
      const mergedFrom = periodFrom ?? current.period_from;
      const mergedTo = periodTo ?? current.period_to;
      if (mergedFrom > mergedTo) throw new BadRequestException('periodFrom não pode ser posterior a periodTo');
      await this.goalsRepo.freeze(client, tenantId, id);
      await this.goalsRepo.insertInTransaction(client, {
        id: newId, tenantId, scope: current.scope, scopeId: current.scope_id, metric: current.metric,
        valueType: dto.valueType ?? current.value_type, targetValue: dto.targetValue ?? Number(current.target_value),
        periodFrom: mergedFrom, periodTo: mergedTo, createdBy: userId,
      });
      await this.goalsRepo.linkSuperseded(client, tenantId, id, newId);
    });
    await this.audit.record({ actorUserId: userId, tenantId, action: 'metrics_goal.updated', entityType: 'metric_goal', entityId: newId, metadata: { supersedes: id, ...dto } });
    const timezone = (await this.metricsRepo.tenantTimezone(tenantId)) || DEFAULT_TENANT_TIMEZONE;
    return this.toResponse(tenantId, await this.goalsRepo.findById(tenantId, newId) as GoalRow, timezone, civilDateInTimezone(new Date(), timezone));
  }

  async remove(tenantId: string, userId: string, id: string) {
    const archived = await this.goalsRepo.archive(tenantId, id);
    if (!archived) throw new NotFoundException('Meta ativa não encontrada');
    await this.audit.record({ actorUserId: userId, tenantId, action: 'metrics_goal.archived', entityType: 'metric_goal', entityId: id });
    return { ok: true, id };
  }
}
