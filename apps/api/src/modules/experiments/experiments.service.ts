import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { POSITIVE_CALL_RESULT_CODES } from '../metrics/metrics.definitions';
import { CreateExperimentDto, EXPERIMENT_GUARDRAIL_METRICS, EXPERIMENT_PRIMARY_METRICS } from './experiments.dto';

const EXPERIMENT_GUARDRAIL_MIN_SAMPLE_SIZE = 20;
const EXPERIMENT_VARIANT_CONFIG_KEYS = ['cadenceMinutes', 'priority'] as const;
type Executor = { query: (text: string, params?: unknown[]) => Promise<any> };

const asNumber = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const round = (value: number, digits = 4) => Math.round(value * (10 ** digits)) / (10 ** digits);

function wilsonInterval(successes: number, trials: number) {
  if (trials <= 0) return null;
  const z = 1.96;
  const p = successes / trials;
  const denominator = 1 + (z ** 2 / trials);
  const centre = p + (z ** 2 / (2 * trials));
  const spread = z * Math.sqrt((p * (1 - p) / trials) + (z ** 2 / (4 * trials ** 2)));
  return { low: round(Math.max(0, (centre - spread) / denominator)), high: round(Math.min(1, (centre + spread) / denominator)), level: 0.95 };
}

@Injectable()
export class ExperimentsService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly flags?: FeatureFlagsService) {}

  private publicExperiment(row: any) {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      campaignId: row.campaign_id,
      name: row.name,
      hypothesis: row.hypothesis,
      primaryMetric: row.primary_metric,
      status: row.status,
      trafficPercent: Number(row.traffic_percent),
      startedAt: row.started_at,
      endedAt: row.ended_at,
      stoppedAt: row.stopped_at,
      stopReason: row.stop_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private normalizeDefinition(input: CreateExperimentDto) {
    if (!EXPERIMENT_PRIMARY_METRICS.includes(input.primaryMetric)) throw new BadRequestException('Métrica primária inválida');
    if (!input.name?.trim() || !input.hypothesis?.trim() || !input.campaignId?.trim()) throw new BadRequestException('Experimento precisa de nome, hipótese e campanha');
    if (!Array.isArray(input.variants) || input.variants.length < 2) throw new BadRequestException('Experimento precisa de pelo menos duas variantes');
    const keys = new Set<string>();
    const variants = input.variants.map((variant) => {
      const key = String(variant.key ?? '').trim();
      if (!key || keys.has(key)) throw new BadRequestException('As variantes precisam ter chaves únicas');
      keys.add(key);
      const config = { cadenceMinutes: Number(variant.cadenceMinutes), priority: Number(variant.priority) };
      if (!Number.isInteger(config.cadenceMinutes) || config.cadenceMinutes < 1 || config.cadenceMinutes > 1440 || !Number.isInteger(config.priority) || config.priority < 0 || config.priority > 100) throw new BadRequestException('Cadência e prioridade da variante são inválidas');
      return { key, name: String(variant.name ?? '').trim(), allocationPercent: Number(variant.allocationPercent), config };
    });
    if (variants.some((variant) => !variant.name)) throw new BadRequestException('Toda variante precisa de nome');
    if (variants.reduce((sum, variant) => sum + variant.allocationPercent, 0) !== 100) throw new BadRequestException('A soma das alocações precisa ser 100%');
    const guardrailKeys = new Set<string>();
    const guardrails = (input.guardrails ?? []).map((guardrail) => {
      if (!EXPERIMENT_GUARDRAIL_METRICS.includes(guardrail.metric) || guardrail.operator !== 'max' || guardrail.threshold < 0 || guardrail.threshold > 1 || guardrailKeys.has(guardrail.metric)) throw new BadRequestException('Guardrails inválidos ou duplicados');
      guardrailKeys.add(guardrail.metric);
      return { metric: guardrail.metric, operator: guardrail.operator, threshold: Number(guardrail.threshold) };
    });
    const missingGuardrails = EXPERIMENT_GUARDRAIL_METRICS.filter((metric) => !guardrailKeys.has(metric));
    if (missingGuardrails.length) throw new BadRequestException({ code: 'experiment_guardrails_incomplete', missing: missingGuardrails, message: 'Falhas, opt-out, quedas rápidas e saúde da linha são guardrails obrigatórios' });
    return { name: input.name.trim(), hypothesis: input.hypothesis.trim(), campaignId: input.campaignId.trim(), primaryMetric: input.primaryMetric, trafficPercent: Math.min(100, Math.max(1, Number(input.trafficPercent ?? 100))), variants, guardrails };
  }

  private async ensureCampaign(tenantId: string, campaignId: string, executor: Executor = this.db) {
    const row = (await executor.query('SELECT id, status FROM campaigns WHERE tenant_id=$1 AND id=$2', [tenantId, campaignId])).rows[0];
    if (!row) throw new NotFoundException('Campanha não encontrada para este tenant');
    return row;
  }

  private async raw(tenantId: string, experimentId: string, executor: Executor = this.db) {
    const experiment = (await executor.query('SELECT * FROM experiments WHERE tenant_id=$1 AND id=$2', [tenantId, experimentId])).rows[0];
    if (!experiment) throw new NotFoundException('Experimento não encontrado');
    const [variants, guardrails] = await Promise.all([
      executor.query('SELECT id, variant_key, name, allocation_percent, config FROM experiment_variants WHERE tenant_id=$1 AND experiment_id=$2 ORDER BY created_at, id', [tenantId, experimentId]),
      executor.query('SELECT id, metric, operator, threshold FROM experiment_guardrails WHERE tenant_id=$1 AND experiment_id=$2 ORDER BY metric', [tenantId, experimentId]),
    ]);
    return { experiment, variants: variants.rows, guardrails: guardrails.rows };
  }

  private shape(raw: { experiment: any; variants: any[]; guardrails: any[] }) {
    return {
      ...this.publicExperiment(raw.experiment),
      variants: raw.variants.map((variant) => ({ id: variant.id, key: variant.variant_key, name: variant.name, allocationPercent: Number(variant.allocation_percent), cadenceMinutes: Number(variant.config?.cadenceMinutes ?? 0), priority: Number(variant.config?.priority ?? 0), config: variant.config })),
      guardrails: raw.guardrails.map((guardrail) => ({ id: guardrail.id, metric: guardrail.metric, operator: guardrail.operator, threshold: Number(guardrail.threshold) })),
    };
  }

  private publicAssignment(row: any) {
    return {
      eligible: true,
      stable: true,
      experimentId: row.experiment_id,
      status: row.status,
      assignmentHash: row.assignment_hash,
      assignedAt: row.assigned_at,
      variant: {
        id: row.variant_id,
        key: row.variant_key,
        name: row.name,
        allocationPercent: Number(row.allocation_percent),
        cadenceMinutes: Number(row.config?.cadenceMinutes ?? 0),
        priority: Number(row.config?.priority ?? 0),
        config: row.config,
      },
    };
  }

  async list(tenantId: string) {
    const result = await this.db.query(`SELECT e.*, count(v.id)::int AS variant_count
      FROM experiments e LEFT JOIN experiment_variants v ON v.tenant_id=e.tenant_id AND v.experiment_id=e.id
      WHERE e.tenant_id=$1 GROUP BY e.id ORDER BY e.updated_at DESC, e.created_at DESC`, [tenantId]);
    return { items: result.rows.map((row) => ({ ...this.publicExperiment(row), variantCount: Number(row.variant_count) })) };
  }

  async get(tenantId: string, experimentId: string) {
    return this.shape(await this.raw(tenantId, experimentId));
  }

  async create(tenantId: string, userId: string, input: CreateExperimentDto) {
    const definition = this.normalizeDefinition(input);
    await this.ensureCampaign(tenantId, definition.campaignId);
    const experimentId = randomUUID();
    await this.db.transaction(async (client) => {
      await client.query(`INSERT INTO experiments (id, tenant_id, campaign_id, name, hypothesis, primary_metric, traffic_percent, assignment_salt, created_by_user_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [experimentId, tenantId, definition.campaignId, definition.name, definition.hypothesis, definition.primaryMetric, definition.trafficPercent, randomUUID(), userId]);
      for (const variant of definition.variants) await client.query(`INSERT INTO experiment_variants (id, tenant_id, experiment_id, variant_key, name, allocation_percent, config)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [randomUUID(), tenantId, experimentId, variant.key, variant.name, variant.allocationPercent, JSON.stringify(variant.config)]);
      for (const guardrail of definition.guardrails) await client.query(`INSERT INTO experiment_guardrails (id, tenant_id, experiment_id, metric, operator, threshold)
        VALUES ($1,$2,$3,$4,$5,$6)`, [randomUUID(), tenantId, experimentId, guardrail.metric, guardrail.operator, guardrail.threshold]);
      await this.audit.record({ actorUserId: userId, tenantId, action: 'experiment.created', entityType: 'experiment', entityId: experimentId, metadata: { campaignId: definition.campaignId, primaryMetric: definition.primaryMetric, variantCount: definition.variants.length } }, client);
    });
    return this.get(tenantId, experimentId);
  }

  private validateStartable(experiment: any) {
    const required = new Set(['failure_rate', 'opt_out_rate', 'rapid_drop_rate', 'line_failure_rate']);
    const missing = experiment.guardrails.filter((guardrail: any) => required.has(guardrail.metric)).length;
    if (experiment.status !== 'draft' && experiment.status !== 'paused') throw new ConflictException({ code: 'experiment_not_startable', status: experiment.status, message: 'Somente rascunhos ou experimentos pausados podem iniciar' });
    if (!experiment.hypothesis?.trim() || !experiment.primaryMetric || experiment.variants.length < 2 || experiment.variants.reduce((sum: number, variant: any) => sum + Number(variant.allocationPercent), 0) !== 100 || missing !== required.size) throw new ConflictException({ code: 'experiment_incomplete', message: 'Hipótese, métrica, variantes e os quatro guardrails são obrigatórios antes de iniciar' });
  }

  async start(tenantId: string, experimentId: string, userId: string) {
    const experiment = await this.get(tenantId, experimentId);
    if (experiment.status !== 'running') this.validateStartable(experiment);
    if (experiment.status === 'running') return experiment;
    await this.db.transaction(async (client) => {
      const concurrent = await client.query(`SELECT id FROM experiments WHERE tenant_id=$1 AND campaign_id=$2 AND status='running' AND id<>$3 LIMIT 1`, [tenantId, experiment.campaignId, experimentId]);
      if (concurrent.rows[0]) throw new ConflictException({ code: 'campaign_experiment_already_running', message: 'A campanha já possui um experimento em execução' });
      const updated = await client.query(`UPDATE experiments SET status='running', started_at=COALESCE(started_at, now()), stopped_at=NULL, stop_reason=NULL, updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND status IN ('draft','paused') RETURNING id`, [tenantId, experimentId]);
      if (!updated.rows[0]) throw new ConflictException('O experimento mudou de estado; atualize e tente novamente');
      await this.audit.record({ actorUserId: userId, tenantId, action: 'experiment.started', entityType: 'experiment', entityId: experimentId }, client);
    });
    return this.get(tenantId, experimentId);
  }

  async pause(tenantId: string, experimentId: string, userId: string) {
    await this.transition(tenantId, experimentId, userId, 'paused', 'experiment.paused', 'Experimento pausado pelo operador');
    return this.get(tenantId, experimentId);
  }

  async stop(tenantId: string, experimentId: string, userId: string, reason?: string) {
    await this.transition(tenantId, experimentId, userId, 'stopped', 'experiment.stopped', reason?.trim() || 'Experimento interrompido pelo operador');
    return this.get(tenantId, experimentId);
  }

  private async transition(tenantId: string, experimentId: string, userId: string, status: 'paused' | 'stopped', action: string, reason: string) {
    await this.db.transaction(async (client) => {
      const result = await client.query(`UPDATE experiments SET status=$3, stopped_at=CASE WHEN $3='stopped' THEN now() ELSE stopped_at END, stop_reason=CASE WHEN $3='stopped' THEN $4 ELSE stop_reason END, updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND status IN ('running','paused') RETURNING id`, [tenantId, experimentId, status, reason]);
      if (!result.rows[0]) throw new ConflictException('Experimento não está em execução ou já foi encerrado');
      await this.audit.record({ actorUserId: userId, tenantId, action, entityType: 'experiment', entityId: experimentId, metadata: { reason } }, client);
    });
  }

  private chooseVariant(experiment: any, hash: string) {
    const bucket = parseInt(hash.slice(0, 8), 16) % 100;
    let cursor = 0;
    for (const variant of experiment.variants) {
      cursor += Number(variant.allocationPercent);
      if (bucket < cursor) return variant;
    }
    return experiment.variants[experiment.variants.length - 1];
  }

  async assign(tenantId: string, experimentId: string, leadId: string) {
    const existing = (await this.db.query(`SELECT a.experiment_id, a.assignment_hash, a.assigned_at, v.id AS variant_id, v.variant_key, v.name, v.allocation_percent, v.config, e.status
      FROM experiment_assignments a JOIN experiment_variants v ON v.tenant_id=a.tenant_id AND v.experiment_id=a.experiment_id AND v.id=a.variant_id
      JOIN experiments e ON e.tenant_id=a.tenant_id AND e.id=a.experiment_id
      WHERE a.tenant_id=$1 AND a.experiment_id=$2 AND a.lead_id=$3`, [tenantId, experimentId, leadId])).rows[0];
    if (existing) return this.publicAssignment(existing);
    const experiment = await this.get(tenantId, experimentId);
    if (experiment.status !== 'running') throw new ConflictException({ code: 'experiment_not_running', status: experiment.status, message: 'Experimento não está recebendo novas atribuições' });
    const guardrails = await this.evaluateGuardrails(tenantId, experimentId);
    if (guardrails.triggered.length) throw new ConflictException({ code: 'experiment_stopped_guardrail', status: 'stopped', triggered: guardrails.triggered, message: 'Experimento interrompido por guardrail' });
    const lead = (await this.db.query('SELECT id, campaign_id FROM leads WHERE tenant_id=$1 AND id=$2', [tenantId, leadId])).rows[0];
    if (!lead) throw new NotFoundException('Lead não encontrado');
    if (String(lead.campaign_id ?? '') !== String(experiment.campaignId)) throw new ConflictException('Lead não pertence à campanha do experimento');
    const assignmentHash = createHash('sha256').update(`${experiment.id}:${tenantId}:${leadId}`).digest('hex');
    const trafficBucket = parseInt(assignmentHash.slice(8, 16), 16) % 100;
    if (trafficBucket >= experiment.trafficPercent) return { eligible: false, stable: true, experimentId, reason: 'outside_traffic_allocation', assignmentHash };
    const variant = this.chooseVariant(experiment, assignmentHash);
    await this.db.query(`INSERT INTO experiment_assignments (tenant_id, experiment_id, lead_id, variant_id, assignment_hash)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id, experiment_id, lead_id) DO NOTHING`, [tenantId, experimentId, leadId, variant.id, assignmentHash]);
    const persisted = (await this.db.query(`SELECT a.experiment_id, a.assignment_hash, a.assigned_at, v.id AS variant_id, v.variant_key, v.name, v.allocation_percent, v.config, e.status
      FROM experiment_assignments a JOIN experiment_variants v ON v.tenant_id=a.tenant_id AND v.experiment_id=a.experiment_id AND v.id=a.variant_id
      JOIN experiments e ON e.tenant_id=a.tenant_id AND e.id=a.experiment_id
      WHERE a.tenant_id=$1 AND a.experiment_id=$2 AND a.lead_id=$3`, [tenantId, experimentId, leadId])).rows[0];
    return persisted ? this.publicAssignment(persisted) : { eligible: true, stable: true, experimentId, assignmentHash, assignedAt: new Date().toISOString(), variant: { id: variant.id, key: variant.key, name: variant.name, allocationPercent: variant.allocationPercent, cadenceMinutes: variant.cadenceMinutes, priority: variant.priority, config: variant.config } };
  }

  async assignForCampaign(tenantId: string, campaignId: string, leadId: string) {
    if (this.flags && !(await this.flags.enabled(tenantId, 'experiments'))) return null;
    const experiment = (await this.db.query(`SELECT id FROM experiments WHERE tenant_id=$1 AND campaign_id=$2 AND status='running' ORDER BY started_at DESC, id LIMIT 1`, [tenantId, campaignId])).rows[0];
    return experiment ? this.assign(tenantId, experiment.id, leadId) : null;
  }

  async evaluateForCampaign(tenantId: string, campaignId: string) {
    if (this.flags && !(await this.flags.enabled(tenantId, 'experiments'))) return null;
    const experiment = (await this.db.query(`SELECT id FROM experiments WHERE tenant_id=$1 AND campaign_id=$2 AND status='running' ORDER BY started_at DESC, id LIMIT 1`, [tenantId, campaignId])).rows[0];
    return experiment ? this.evaluateGuardrails(tenantId, experiment.id) : null;
  }

  async evaluateGuardrails(tenantId: string, experimentId: string) {
    const experiment = (await this.db.query('SELECT id, status, started_at FROM experiments WHERE tenant_id=$1 AND id=$2', [tenantId, experimentId])).rows[0];
    if (!experiment) throw new NotFoundException('Experimento não encontrado');
    const guardrails = (await this.db.query('SELECT metric, operator, threshold FROM experiment_guardrails WHERE tenant_id=$1 AND experiment_id=$2 ORDER BY metric', [tenantId, experimentId])).rows;
    if (experiment.status !== 'running') return { experimentId, status: experiment.status, triggered: [], evaluations: [] };
    const metrics = (await this.db.query(`WITH scope AS (
        SELECT ea.lead_id, l.do_not_call, c.id, c.status, c.connected_duration_seconds, c.number_id
        FROM experiment_assignments ea
        JOIN experiments e ON e.tenant_id=ea.tenant_id AND e.id=ea.experiment_id
        LEFT JOIN leads l ON l.tenant_id=ea.tenant_id AND l.id=ea.lead_id
        LEFT JOIN calls c ON c.tenant_id=ea.tenant_id AND c.lead_id=ea.lead_id AND c.experiment_id=e.id AND c.created_at >= e.started_at
        WHERE ea.tenant_id=$1 AND ea.experiment_id=$2
      ), line_scope AS (
        SELECT number_id, count(id)::numeric AS calls, count(id) FILTER (WHERE status='failed')::numeric AS failed
        FROM scope WHERE id IS NOT NULL GROUP BY number_id
      ), totals AS (
        SELECT count(DISTINCT lead_id)::numeric AS assigned,
          count(id)::numeric AS calls,
          count(id) FILTER (WHERE status='failed')::numeric AS failed,
          count(id) FILTER (WHERE connected_duration_seconds IS NOT NULL AND connected_duration_seconds <= 5)::numeric AS rapid_drops,
          count(DISTINCT lead_id) FILTER (WHERE do_not_call=true)::numeric AS opt_outs
        FROM scope
      )
      SELECT assigned, calls, failed, rapid_drops, opt_outs,
        coalesce((SELECT max(failed / nullif(calls, 0)) FROM line_scope), 0)::numeric AS line_failure_rate
      FROM totals`, [tenantId, experimentId])).rows[0] ?? {};
    const valueFor = (metric: string) => ({
      failure_rate: { value: asNumber(metrics.failed) / Math.max(1, asNumber(metrics.calls)), sampleSize: asNumber(metrics.calls) },
      opt_out_rate: { value: asNumber(metrics.opt_outs) / Math.max(1, asNumber(metrics.assigned)), sampleSize: asNumber(metrics.assigned) },
      rapid_drop_rate: { value: asNumber(metrics.rapid_drops) / Math.max(1, asNumber(metrics.calls)), sampleSize: asNumber(metrics.calls) },
      line_failure_rate: { value: asNumber(metrics.line_failure_rate), sampleSize: asNumber(metrics.calls) },
    } as Record<string, { value: number; sampleSize: number }>)[metric] ?? { value: 0, sampleSize: 0 };
    const evaluations = guardrails.map((guardrail) => {
      const observed = valueFor(guardrail.metric);
      const sufficient = observed.sampleSize >= EXPERIMENT_GUARDRAIL_MIN_SAMPLE_SIZE;
      const triggered = sufficient && (guardrail.operator === 'max' ? observed.value > asNumber(guardrail.threshold) : observed.value < asNumber(guardrail.threshold));
      return { metric: guardrail.metric, operator: guardrail.operator, observedValue: round(observed.value), threshold: asNumber(guardrail.threshold), sampleSize: observed.sampleSize, action: triggered ? 'stopped' : sufficient ? 'observed' : 'insufficient_data', triggered };
    });
    const triggered = evaluations.filter((evaluation) => evaluation.triggered);
    if (triggered.length) {
      await this.db.transaction(async (client) => {
        for (const evaluation of evaluations) await client.query(`INSERT INTO experiment_guardrail_evaluations (id, tenant_id, experiment_id, metric, observed_value, threshold, sample_size, action)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(), tenantId, experimentId, evaluation.metric, evaluation.observedValue, evaluation.threshold, evaluation.sampleSize, evaluation.action]);
        await client.query(`UPDATE experiments SET status='stopped', stopped_at=now(), stop_reason=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='running'`, [tenantId, experimentId, `Guardrail disparado: ${triggered.map((item) => item.metric).join(', ')}`]);
        await this.audit.record({ tenantId, action: 'experiment.guardrail_triggered', entityType: 'experiment', entityId: experimentId, metadata: { triggered: triggered.map((item) => ({ metric: item.metric, observedValue: item.observedValue, threshold: item.threshold, sampleSize: item.sampleSize })) } }, client);
      });
    } else {
      await this.db.transaction(async (client) => {
        for (const evaluation of evaluations) await client.query(`INSERT INTO experiment_guardrail_evaluations (id, tenant_id, experiment_id, metric, observed_value, threshold, sample_size, action)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(), tenantId, experimentId, evaluation.metric, evaluation.observedValue, evaluation.threshold, evaluation.sampleSize, evaluation.action]);
      });
    }
    return { experimentId, status: triggered.length ? 'stopped' : 'running', triggered, evaluations, minimumSampleSize: EXPERIMENT_GUARDRAIL_MIN_SAMPLE_SIZE };
  }

  async report(tenantId: string, experimentId: string) {
    const guardrailResult = await this.evaluateGuardrails(tenantId, experimentId);
    const raw = await this.raw(tenantId, experimentId);
    const rows = (await this.db.query(`SELECT v.id, v.variant_key, v.name, v.allocation_percent, v.config,
        count(DISTINCT ea.lead_id)::int AS assigned_count,
        count(c.id)::int AS call_count,
        count(c.id) FILTER (WHERE c.connected_at IS NOT NULL)::int AS answered_count,
        count(c.id) FILTER (WHERE c.call_result = ANY($3::text[]))::int AS positive_count,
        count(c.id) FILTER (WHERE c.status='failed')::int AS failed_count,
        count(c.id) FILTER (WHERE c.connected_duration_seconds IS NOT NULL AND c.connected_duration_seconds <= 5)::int AS rapid_drop_count,
        count(DISTINCT ea.lead_id) FILTER (WHERE l.do_not_call=true)::int AS opt_out_count
      FROM experiments e JOIN experiment_variants v ON v.tenant_id=e.tenant_id AND v.experiment_id=e.id
      LEFT JOIN experiment_assignments ea ON ea.tenant_id=v.tenant_id AND ea.experiment_id=v.experiment_id AND ea.variant_id=v.id
      LEFT JOIN leads l ON l.tenant_id=ea.tenant_id AND l.id=ea.lead_id
      LEFT JOIN calls c ON c.tenant_id=ea.tenant_id AND c.lead_id=ea.lead_id AND c.experiment_id=e.id AND c.created_at >= e.started_at
      WHERE e.tenant_id=$1 AND e.id=$2
      GROUP BY v.id, v.variant_key, v.name, v.allocation_percent, v.config
      ORDER BY v.created_at, v.id`, [tenantId, experimentId, POSITIVE_CALL_RESULT_CODES])).rows;
    const primaryMetric = raw.experiment.primary_metric;
    const variants = rows.map((row) => {
      const calls = Number(row.call_count);
      const successes = primaryMetric === 'answer_rate' ? Number(row.answered_count) : primaryMetric === 'positive_rate' ? Number(row.positive_count) : primaryMetric === 'failure_rate' ? Number(row.failed_count) : Number(row.rapid_drop_count);
      const value = calls ? round(successes / calls) : null;
      return {
        id: row.id,
        key: row.variant_key,
        name: row.name,
        allocationPercent: Number(row.allocation_percent),
        config: row.config,
        assignedCount: Number(row.assigned_count),
        calls,
        answered: Number(row.answered_count),
        positive: Number(row.positive_count),
        failed: Number(row.failed_count),
        rapidDrops: Number(row.rapid_drop_count),
        optOuts: Number(row.opt_out_count),
        primaryMetric: { key: primaryMetric, numerator: successes, denominator: calls, value, uncertainty: wilsonInterval(successes, calls) },
      };
    });
    const controlValue = variants[0]?.primaryMetric.value;
    return {
      experiment: this.publicExperiment(raw.experiment),
      primaryMetric,
      variants: variants.map((variant) => ({ ...variant, observedDifferenceFromFirstVariant: controlValue == null || variant.primaryMetric.value == null ? null : round(variant.primaryMetric.value - controlValue) })),
      guardrails: { ...guardrailResult, definitions: raw.guardrails.map((guardrail: any) => ({ metric: guardrail.metric, operator: guardrail.operator, threshold: Number(guardrail.threshold) })) },
      attribution: { method: 'sha256 tenant + experiment + lead', stable: true },
      winner: null,
      interpretation: 'Diferenças observadas, intervalos de incerteza de 95% e amostras são descritivos. Este relatório não declara vencedor nem causalidade fora do desenho experimental.',
    };
  }
}
