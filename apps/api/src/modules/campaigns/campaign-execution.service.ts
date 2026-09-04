import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { CampaignConfig, EffectiveCampaignValue, resolveEffectiveCampaignConfig } from './campaigns.domain';

type QueryExecutor = { query: (text: string, params?: unknown[]) => Promise<any> };

export type CampaignExecution = {
  allowed: boolean;
  reason: string;
  campaignId: string | null;
  campaignVersion: number | null;
  status: string | null;
  sdrIds: string[];
  numberIds: string[];
  effectiveConfig: {
    maxAttemptsPerLead: EffectiveCampaignValue<number>;
    retryDelayMinutes: EffectiveCampaignValue<number>;
    maxCallsPerMinute: EffectiveCampaignValue<number>;
    minSecondsBetweenCalls: EffectiveCampaignValue<number>;
    queueStrategy: EffectiveCampaignValue<string>;
    timezone?: string;
    scheduleWindows: Array<{ dayOfWeek: number; startTime: string; endTime: string }>;
  };
};

type LeadContext = { id: string; folder_id: string; campaign_id?: string | null; campaign_version?: number | null };
type ResourceOptions = { sdrId?: string; numberId?: string; globalSettings?: Record<string, unknown> };

const asIds = (value: unknown) => Array.isArray(value) ? value.map(String) : [];
const asRules = (snapshot: any): CampaignConfig => {
  const rules = snapshot?.rules ?? {};
  return {
    queueStrategy: rules.queueStrategy,
    maxAttemptsPerLead: rules.maxAttemptsPerLead == null ? undefined : Number(rules.maxAttemptsPerLead),
    retryDelayMinutes: rules.retryDelayMinutes == null ? undefined : Number(rules.retryDelayMinutes),
    maxCallsPerMinute: rules.maxCallsPerMinute == null ? undefined : Number(rules.maxCallsPerMinute),
    minSecondsBetweenCalls: rules.minSecondsBetweenCalls == null ? undefined : Number(rules.minSecondsBetweenCalls),
    timezone: rules.timezone,
    scheduleWindows: Array.isArray(rules.scheduleWindows) ? rules.scheduleWindows : [],
  };
};

const hashForRotation = (value: string) => {
  let hash = 0;
  for (const character of value) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return Math.abs(hash);
};

const globalConfig = (settings: Record<string, unknown> = {}) => ({
  maxAttemptsPerLead: Math.max(1, Number(settings.max_attempts_per_lead ?? 2) || 2),
  retryDelayMinutes: Math.max(1, Number(settings.retry_delay_minutes ?? 30) || 30),
  maxCallsPerMinute: Math.max(1, Number(settings.max_calls_per_minute ?? 6) || 6),
  minSecondsBetweenCalls: Math.max(0, Number(settings.min_seconds_between_calls ?? 10) || 0),
  queueStrategy: String(settings.queue_strategy ?? 'fifo') as 'fifo' | 'lifo' | 'priority_fifo',
});

const noCampaignConfig = (settings: Record<string, unknown> = {}) => {
  const global = globalConfig(settings);
  const effective = resolveEffectiveCampaignConfig(global, {});
  return {
    ...effective,
    timezone: undefined,
    scheduleWindows: [],
  } as CampaignExecution['effectiveConfig'];
};

const matchesResource = (row: any, options: ResourceOptions) =>
  (!options.sdrId || asIds(row.sdr_ids).includes(options.sdrId))
  && (!options.numberId || asIds(row.number_ids).includes(options.numberId));

@Injectable()
export class CampaignExecutionService {
  constructor(private readonly db: DatabaseService) {}

  async resolveForLead(tenantId: string, lead: LeadContext, options: ResourceOptions = {}, executor: QueryExecutor = this.db): Promise<CampaignExecution> {
    const global = globalConfig(options.globalSettings);
    const fallback = noCampaignConfig(options.globalSettings);
    let rows: any[];

    if (lead.campaign_id) {
      rows = (await executor.query(`SELECT c.id, c.status, c.current_version,
          COALESCE(cv.config_snapshot, '{}'::jsonb) AS config_snapshot,
          COALESCE((SELECT array_agg(cs.sdr_id ORDER BY cs.sdr_id) FROM campaign_sdrs cs WHERE cs.tenant_id=c.tenant_id AND cs.campaign_id=c.id), ARRAY[]::text[]) AS sdr_ids,
          COALESCE((SELECT array_agg(cn.number_id ORDER BY cn.number_id) FROM campaign_numbers cn WHERE cn.tenant_id=c.tenant_id AND cn.campaign_id=c.id), ARRAY[]::text[]) AS number_ids
        FROM campaigns c
        LEFT JOIN campaign_versions cv ON cv.tenant_id=c.tenant_id AND cv.campaign_id=c.id
          AND cv.version=COALESCE($3::int, c.current_version)
        WHERE c.tenant_id=$1 AND c.id=$2 AND c.current_version IS NOT NULL`, [tenantId, lead.campaign_id, lead.campaign_version ?? null])).rows;
      if (!rows[0]) return { allowed: false, reason: 'campaign_not_found', campaignId: lead.campaign_id, campaignVersion: lead.campaign_version ?? null, status: null, sdrIds: [], numberIds: [], effectiveConfig: fallback };
    } else {
      rows = (await executor.query(`SELECT c.id, c.status, c.current_version,
          cv.config_snapshot,
          COALESCE((SELECT array_agg(cs.sdr_id ORDER BY cs.sdr_id) FROM campaign_sdrs cs WHERE cs.tenant_id=c.tenant_id AND cs.campaign_id=c.id), ARRAY[]::text[]) AS sdr_ids,
          COALESCE((SELECT array_agg(cn.number_id ORDER BY cn.number_id) FROM campaign_numbers cn WHERE cn.tenant_id=c.tenant_id AND cn.campaign_id=c.id), ARRAY[]::text[]) AS number_ids
        FROM campaigns c
        JOIN campaign_versions cv ON cv.tenant_id=c.tenant_id AND cv.campaign_id=c.id AND cv.version=c.current_version
        WHERE c.tenant_id=$1 AND c.folder_id=$2 AND c.status='running' AND c.current_version IS NOT NULL
        ORDER BY c.started_at NULLS LAST, c.id`, [tenantId, lead.folder_id])).rows;
      if (!rows.length) return { allowed: true, reason: 'legacy_fallback', campaignId: null, campaignVersion: null, status: null, sdrIds: [], numberIds: [], effectiveConfig: fallback };
    }

    const compatible = rows.filter((row) => matchesResource(row, options));
    const selected = compatible.length
      ? compatible[hashForRotation(lead.id) % compatible.length]
      : options.sdrId || options.numberId ? undefined : rows[hashForRotation(lead.id) % rows.length];
    const row = selected ?? rows[0];
    const campaignRules = asRules(row.config_snapshot);
    const effective = resolveEffectiveCampaignConfig(global, campaignRules);
    const effectiveConfig = {
      ...effective,
      timezone: campaignRules.timezone,
      scheduleWindows: campaignRules.scheduleWindows ?? [],
    };
    const version = lead.campaign_version == null ? Number(row.current_version) : Number(lead.campaign_version);
    if (row.status !== 'running') return { allowed: false, reason: 'campaign_not_running', campaignId: row.id, campaignVersion: version, status: row.status, sdrIds: asIds(row.sdr_ids), numberIds: asIds(row.number_ids), effectiveConfig };
    if (!selected) return { allowed: false, reason: 'campaign_resource_not_allowed', campaignId: row.id, campaignVersion: version, status: row.status, sdrIds: asIds(row.sdr_ids), numberIds: asIds(row.number_ids), effectiveConfig };
    return { allowed: true, reason: 'campaign_running', campaignId: row.id, campaignVersion: version, status: row.status, sdrIds: asIds(row.sdr_ids), numberIds: asIds(row.number_ids), effectiveConfig };
  }

  static scheduleAllowed(config: CampaignExecution['effectiveConfig'], now = new Date()) {
    if (!config.scheduleWindows.length) return true;
    let day = now.getDay();
    let time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (config.timezone) {
      try {
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
        const weekday = parts.find((part) => part.type === 'weekday')?.value;
        day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday ?? '');
        time = `${parts.find((part) => part.type === 'hour')?.value ?? '00'}:${parts.find((part) => part.type === 'minute')?.value ?? '00'}`;
      } catch { return true; }
    }
    return config.scheduleWindows.some((window) => window.dayOfWeek === day && time >= window.startTime && time < window.endTime);
  }
}
