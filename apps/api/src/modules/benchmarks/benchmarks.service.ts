import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { POSITIVE_CALL_RESULT_CODES } from '../metrics/metrics.definitions';
import { BENCHMARK_PURPOSES, BENCHMARK_TERMS_VERSION, BenchmarkConsentDto } from './benchmarks.dto';

const MAX_PERIOD_MS = 366 * 24 * 60 * 60 * 1000;
const DEFAULT_MINIMUM_TENANTS = 5;
const DEFAULT_MINIMUM_CALLS_PER_TENANT = 20;
const round = (value: number, digits = 4) => Math.round(value * (10 ** digits)) / (10 ** digits);

type BenchmarkPolicy = {
  termsVersion: string;
  purposes: readonly string[];
  minimumTenants: number;
  minimumCallsPerTenant: number;
  retentionDays: number;
  consentApproved: boolean;
};

@Injectable()
export class BenchmarksService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  private policy(): BenchmarkPolicy {
    const configuredTenants = Number(process.env.BENCHMARK_MIN_TENANTS);
    const configuredCalls = Number(process.env.BENCHMARK_MIN_CALLS_PER_TENANT);
    const configuredRetention = Number(process.env.BENCHMARK_AGGREGATE_RETENTION_DAYS);
    return {
      termsVersion: BENCHMARK_TERMS_VERSION,
      purposes: BENCHMARK_PURPOSES,
      minimumTenants: Number.isInteger(configuredTenants) && configuredTenants >= 3 ? configuredTenants : DEFAULT_MINIMUM_TENANTS,
      minimumCallsPerTenant: Number.isInteger(configuredCalls) && configuredCalls >= 1 ? configuredCalls : DEFAULT_MINIMUM_CALLS_PER_TENANT,
      retentionDays: Number.isInteger(configuredRetention) && configuredRetention >= 1 ? configuredRetention : 30,
      // The legal copy and final purpose wording are external dependencies. The
      // infrastructure can be deployed first, but opt-in stays closed until an
      // explicit release switch is set by the operator.
      consentApproved: process.env.BENCHMARK_CONSENT_APPROVED === 'true',
    };
  }

  private period(from?: string, to?: string) {
    const end = to ? new Date(to) : new Date();
    const start = from ? new Date(from) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new BadRequestException('Período de benchmark inválido');
    if (end.getTime() - start.getTime() > MAX_PERIOD_MS) throw new BadRequestException('O período máximo de benchmark é de 366 dias');
    return { start, end };
  }

  private publicConsent(row: any) {
    return row ? {
      decision: row.decision,
      termsVersion: row.terms_version,
      purposes: row.purposes ?? [],
      createdAt: row.created_at,
      reason: row.reason ?? null,
    } : null;
  }

  private async latestConsent(tenantId: string) {
    return (await this.db.query(`SELECT decision, terms_version, purposes, reason, created_at
      FROM benchmark_consent_events WHERE tenant_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1`, [tenantId])).rows[0] ?? null;
  }

  async consent(tenantId: string) {
    const policy = this.policy();
    const current = await this.latestConsent(tenantId);
    return {
      status: current?.decision ?? 'not_set',
      consent: this.publicConsent(current),
      policy: {
        termsVersion: policy.termsVersion,
        purposes: policy.purposes,
        minimumTenants: policy.minimumTenants,
        minimumCallsPerTenant: policy.minimumCallsPerTenant,
        retentionDays: policy.retentionDays,
        consentApproved: policy.consentApproved,
      },
    };
  }

  private assertOptInPayload(input: BenchmarkConsentDto, policy: BenchmarkPolicy) {
    if (input.termsVersion !== policy.termsVersion) throw new BadRequestException({ code: 'benchmark_terms_outdated', requiredVersion: policy.termsVersion });
    const purposes = [...new Set((input.purposes ?? []).map((purpose) => String(purpose)))];
    if (purposes.length !== policy.purposes.length || purposes.some((purpose) => !policy.purposes.includes(purpose))) throw new BadRequestException('A finalidade do consentimento não corresponde à versão vigente');
  }

  private async recordConsent(tenantId: string, userId: string, decision: 'opt_in' | 'opt_out', termsVersion: string, purposes: readonly string[], reason?: string) {
    const id = randomUUID();
    await this.db.transaction(async (client) => {
      await client.query(`INSERT INTO benchmark_consent_events (id, tenant_id, decision, terms_version, purposes, actor_user_id, reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, tenantId, decision, termsVersion, [...purposes], userId, reason?.trim() || null]);
      await this.audit.record({ actorUserId: userId, tenantId, action: decision === 'opt_in' ? 'benchmark.consent_opted_in' : 'benchmark.consent_revoked', entityType: 'tenant', entityId: tenantId, metadata: { termsVersion, purposes: [...purposes], reason: reason?.trim() || null } }, client);
    });
    return this.consent(tenantId);
  }

  async optIn(tenantId: string, userId: string, input: BenchmarkConsentDto) {
    const policy = this.policy();
    this.assertOptInPayload(input, policy);
    if (!policy.consentApproved) throw new ConflictException({ code: 'benchmark_legal_approval_pending', message: 'O texto jurídico do benchmark ainda não foi aprovado para liberação' });
    return this.recordConsent(tenantId, userId, 'opt_in', policy.termsVersion, policy.purposes);
  }

  async revoke(tenantId: string, userId: string, reason?: string) {
    const policy = this.policy();
    return this.recordConsent(tenantId, userId, 'opt_out', policy.termsVersion, policy.purposes, reason || 'Revogado pelo operador');
  }

  private async assertBenchmarkRelease(tenantId: string) {
    const policy = this.policy();
    if (!policy.consentApproved) return { policy, consent: null, blocked: 'pending_legal_approval' as const };
    const current = await this.latestConsent(tenantId);
    if (!current || current.decision !== 'opt_in' || current.terms_version !== policy.termsVersion) return { policy, consent: current, blocked: 'consent_required' as const };
    return { policy, consent: current, blocked: null };
  }

  private async cohortRows(from?: string, to?: string) {
    const policy = this.policy();
    const { start, end } = this.period(from, to);
    const result = await this.db.query(`WITH latest_consent AS (
        SELECT DISTINCT ON (tenant_id) tenant_id, decision, terms_version
        FROM benchmark_consent_events
        ORDER BY tenant_id, created_at DESC, id DESC
      ), eligible_tenants AS (
        SELECT lc.tenant_id
        FROM latest_consent lc JOIN tenants t ON t.id=lc.tenant_id
        WHERE lc.decision='opt_in' AND lc.terms_version=$5 AND t.status='active'
      ), team_sizes AS (
        SELECT et.tenant_id, count(tm.id) FILTER (WHERE tm.status='active')::int AS member_count
        FROM eligible_tenants et LEFT JOIN tenant_memberships tm ON tm.tenant_id=et.tenant_id
        GROUP BY et.tenant_id
      ), call_stats AS (
        SELECT c.tenant_id,
          count(*)::int AS calls,
          count(*) FILTER (WHERE c.connected_at IS NOT NULL)::int AS answered,
          count(*) FILTER (WHERE c.call_result = ANY($6::text[]))::int AS positive
        FROM calls c JOIN eligible_tenants et ON et.tenant_id=c.tenant_id
        WHERE c.created_at >= $1 AND c.created_at < $2
        GROUP BY c.tenant_id
      ), tenant_metrics AS (
        SELECT ts.tenant_id,
          CASE WHEN ts.member_count <= 5 THEN '1_5' WHEN ts.member_count <= 20 THEN '6_20' ELSE '21_plus' END AS team_size_band,
          CASE WHEN cs.calls < 100 THEN '20_99' WHEN cs.calls < 500 THEN '100_499' ELSE '500_plus' END AS volume_band,
          cs.calls,
          cs.answered::numeric / NULLIF(cs.calls, 0) AS answer_rate,
          cs.positive::numeric / NULLIF(cs.calls, 0) AS positive_rate
        FROM team_sizes ts JOIN call_stats cs ON cs.tenant_id=ts.tenant_id
        WHERE cs.calls >= $3
      ), cohort_bounds AS (
        SELECT team_size_band, volume_band, count(*)::int AS tenant_count, sum(calls)::int AS call_count,
          percentile_cont(0.25) WITHIN GROUP (ORDER BY answer_rate) AS answer_rate_p25,
          percentile_cont(0.50) WITHIN GROUP (ORDER BY answer_rate) AS answer_rate_median,
          percentile_cont(0.75) WITHIN GROUP (ORDER BY answer_rate) AS answer_rate_p75
        FROM tenant_metrics
        GROUP BY team_size_band, volume_band
        HAVING count(*) >= $4
      )
      SELECT cb.team_size_band, cb.volume_band, cb.tenant_count, cb.call_count,
        cb.answer_rate_p25, cb.answer_rate_median, cb.answer_rate_p75,
        round(avg(GREATEST(cb.answer_rate_p25, LEAST(cb.answer_rate_p75, tm.answer_rate)))::numeric, 4) AS answer_rate_trimmed,
        round(avg(GREATEST(cb.answer_rate_p25, LEAST(cb.answer_rate_p75, tm.positive_rate)))::numeric, 4) AS positive_rate_trimmed
      FROM cohort_bounds cb JOIN tenant_metrics tm ON tm.team_size_band=cb.team_size_band AND tm.volume_band=cb.volume_band
      GROUP BY cb.team_size_band, cb.volume_band, cb.tenant_count, cb.call_count, cb.answer_rate_p25, cb.answer_rate_median, cb.answer_rate_p75
      ORDER BY cb.team_size_band, cb.volume_band`, [start.toISOString(), end.toISOString(), policy.minimumCallsPerTenant, policy.minimumTenants, policy.termsVersion, POSITIVE_CALL_RESULT_CODES]);
    return { policy, start, end, rows: result.rows };
  }

  private publicCohort(row: any) {
    return {
      cohortKey: `${row.team_size_band}:${row.volume_band}`,
      teamSizeBand: row.team_size_band,
      volumeBand: row.volume_band,
      eligibleTenants: Number(row.tenant_count),
      calls: Number(row.call_count),
      answerRate: {
        p25: row.answer_rate_p25 == null ? null : round(Number(row.answer_rate_p25)),
        median: row.answer_rate_median == null ? null : round(Number(row.answer_rate_median)),
        p75: row.answer_rate_p75 == null ? null : round(Number(row.answer_rate_p75)),
        trimmedMean: row.answer_rate_trimmed == null ? null : round(Number(row.answer_rate_trimmed)),
      },
      positiveRateTrimmedMean: row.positive_rate_trimmed == null ? null : round(Number(row.positive_rate_trimmed)),
    };
  }

  async cohorts(tenantId: string, from?: string, to?: string) {
    const access = await this.assertBenchmarkRelease(tenantId);
    const base = { policy: { termsVersion: access.policy.termsVersion, minimumTenants: access.policy.minimumTenants, minimumCallsPerTenant: access.policy.minimumCallsPerTenant, retentionDays: access.policy.retentionDays, consentApproved: access.policy.consentApproved }, period: null as any, methodology: 'Coortes por porte de equipe e volume no período; somente taxas agregadas, percentis e médias aparadas, sem ranking nominal.' };
    if (access.blocked) return { ...base, status: access.blocked, consent: this.publicConsent(access.consent), items: [] };
    const result = await this.cohortRows(from, to);
    return { ...base, status: result.rows.length ? 'ready' : 'insufficient_data', consent: this.publicConsent(access.consent), period: { from: result.start.toISOString(), to: result.end.toISOString() }, items: result.rows.map((row) => this.publicCohort(row)) };
  }

  async inspectCohorts(from?: string, to?: string) {
    const policy = this.policy();
    if (!policy.consentApproved) return { status: 'pending_legal_approval', policy, period: null, items: [] };
    const result = await this.cohortRows(from, to);
    return { status: result.rows.length ? 'ready' : 'insufficient_data', policy: { termsVersion: policy.termsVersion, minimumTenants: policy.minimumTenants, minimumCallsPerTenant: policy.minimumCallsPerTenant, retentionDays: policy.retentionDays }, period: { from: result.start.toISOString(), to: result.end.toISOString() }, items: result.rows.map((row) => this.publicCohort(row)) };
  }

  async refreshCohorts(from?: string, to?: string) {
    const policy = this.policy();
    if (!policy.consentApproved) return { status: 'pending_legal_approval', policy, runId: null, items: [] };
    const result = await this.cohortRows(from, to);
    const runId = randomUUID();
    await this.db.transaction(async (client) => {
      await client.query(`INSERT INTO benchmark_cohort_runs (id, period_start, period_end, minimum_tenants, minimum_calls_per_tenant, status, cohort_count, details)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [runId, result.start.toISOString(), result.end.toISOString(), policy.minimumTenants, policy.minimumCallsPerTenant, result.rows.length ? 'completed' : 'insufficient_data', result.rows.length, JSON.stringify({ termsVersion: policy.termsVersion, methodology: 'trimmed_percentiles', pii: false })]);
      for (const row of result.rows) await client.query(`INSERT INTO benchmark_cohort_aggregates
        (id, run_id, cohort_key, team_size_band, volume_band, tenant_count, call_count, answer_rate_p25, answer_rate_median, answer_rate_p75, answer_rate_trimmed, positive_rate_trimmed)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [randomUUID(), runId, `${row.team_size_band}:${row.volume_band}`, row.team_size_band, row.volume_band, row.tenant_count, row.call_count, row.answer_rate_p25, row.answer_rate_median, row.answer_rate_p75, row.answer_rate_trimmed, row.positive_rate_trimmed]);
      await client.query(`DELETE FROM benchmark_cohort_runs WHERE computed_at < now() - ($1::int * interval '1 day')`, [policy.retentionDays]);
    });
    return { status: result.rows.length ? 'completed' : 'insufficient_data', runId, period: { from: result.start.toISOString(), to: result.end.toISOString() }, items: result.rows.map((row) => this.publicCohort(row)) };
  }
}
