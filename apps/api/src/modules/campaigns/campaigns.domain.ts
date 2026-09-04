import { createHash } from 'node:crypto';

export const CAMPAIGN_QUEUE_STRATEGIES = ['fifo', 'lifo', 'priority_fifo'] as const;

export type CampaignConfig = {
  queueStrategy?: (typeof CAMPAIGN_QUEUE_STRATEGIES)[number];
  maxAttemptsPerLead?: number;
  retryDelayMinutes?: number;
  maxCallsPerMinute?: number;
  minSecondsBetweenCalls?: number;
  timezone?: string;
  scheduleWindows?: Array<{ dayOfWeek: number; startTime: string; endTime: string }>;
  resultIds?: string[];
};

export type CampaignDefinition = {
  name: string;
  description?: string | null;
  folderId: string;
  primaryGoalMetric?: string | null;
  primaryGoalTarget?: number | null;
  sdrIds: string[];
  numberIds: string[];
  config: CampaignConfig;
};

export type CampaignValidationIssue = { code: string; path: string; message: string };

const validTime = (value: unknown) => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const integerInRange = (value: unknown, min: number, max: number) => Number.isInteger(value) && Number(value) >= min && Number(value) <= max;

export function validateCampaignDefinition(definition: CampaignDefinition, forPublish = false): CampaignValidationIssue[] {
  const issues: CampaignValidationIssue[] = [];
  if (definition.name.trim().length < 2) issues.push({ code: 'campaign_name_required', path: 'name', message: 'Informe um nome com ao menos 2 caracteres' });
  if (!definition.folderId) issues.push({ code: 'campaign_folder_required', path: 'folderId', message: 'Selecione a pasta principal' });
  if (forPublish && !definition.sdrIds.length) issues.push({ code: 'campaign_team_required', path: 'sdrIds', message: 'Selecione ao menos um SDR' });
  if (forPublish && !definition.numberIds.length) issues.push({ code: 'campaign_number_required', path: 'numberIds', message: 'Selecione ao menos uma linha' });

  const config = definition.config ?? {};
  if (config.queueStrategy !== undefined && !CAMPAIGN_QUEUE_STRATEGIES.includes(config.queueStrategy)) {
    issues.push({ code: 'campaign_queue_strategy_invalid', path: 'config.queueStrategy', message: 'Estratégia de fila inválida' });
  }
  const ranges: Array<[keyof CampaignConfig, number, number]> = [
    ['maxAttemptsPerLead', 1, 20],
    ['retryDelayMinutes', 1, 43_200],
    ['maxCallsPerMinute', 1, 60],
    ['minSecondsBetweenCalls', 0, 3_600],
  ];
  for (const [key, min, max] of ranges) {
    if (config[key] !== undefined && !integerInRange(config[key], min, max)) {
      issues.push({ code: 'campaign_rule_out_of_range', path: `config.${key}`, message: `Use um inteiro entre ${min} e ${max}` });
    }
  }
  if (config.timezone !== undefined) {
    try { new Intl.DateTimeFormat('pt-BR', { timeZone: config.timezone }).format(); }
    catch { issues.push({ code: 'campaign_timezone_invalid', path: 'config.timezone', message: 'Fuso horário inválido' }); }
  }
  const windows = config.scheduleWindows ?? [];
  windows.forEach((window, index) => {
    if (!integerInRange(window.dayOfWeek, 0, 6) || !validTime(window.startTime) || !validTime(window.endTime) || window.startTime >= window.endTime) {
      issues.push({ code: 'campaign_schedule_window_invalid', path: `config.scheduleWindows.${index}`, message: 'Janela de agenda inválida' });
    }
  });
  const uniqueWindows = new Set(windows.map((window) => `${window.dayOfWeek}:${window.startTime}:${window.endTime}`));
  if (uniqueWindows.size !== windows.length) issues.push({ code: 'campaign_schedule_window_duplicate', path: 'config.scheduleWindows', message: 'Remova janelas duplicadas' });
  if (config.resultIds && new Set(config.resultIds).size !== config.resultIds.length) {
    issues.push({ code: 'campaign_result_duplicate', path: 'config.resultIds', message: 'Remova resultados duplicados' });
  }
  return issues;
}

export type EffectiveCampaignValue<T> = { value: T; origin: 'global_default' | 'campaign_override' | 'safety_cap' };

export function resolveEffectiveCampaignConfig(global: Required<Pick<CampaignConfig, 'maxAttemptsPerLead' | 'retryDelayMinutes' | 'maxCallsPerMinute' | 'minSecondsBetweenCalls' | 'queueStrategy'>>, campaign: CampaignConfig) {
  const cappedMaximum = (key: 'maxAttemptsPerLead' | 'maxCallsPerMinute'): EffectiveCampaignValue<number> => {
    const requested = campaign[key];
    if (requested === undefined) return { value: global[key], origin: 'global_default' };
    if (requested > global[key]) return { value: global[key], origin: 'safety_cap' };
    return { value: requested, origin: 'campaign_override' };
  };
  const requestedMinimum = campaign.minSecondsBetweenCalls;
  return {
    maxAttemptsPerLead: cappedMaximum('maxAttemptsPerLead'),
    maxCallsPerMinute: cappedMaximum('maxCallsPerMinute'),
    retryDelayMinutes: campaign.retryDelayMinutes === undefined
      ? { value: global.retryDelayMinutes, origin: 'global_default' } as EffectiveCampaignValue<number>
      : { value: campaign.retryDelayMinutes, origin: 'campaign_override' } as EffectiveCampaignValue<number>,
    minSecondsBetweenCalls: requestedMinimum === undefined
      ? { value: global.minSecondsBetweenCalls, origin: 'global_default' } as EffectiveCampaignValue<number>
      : requestedMinimum < global.minSecondsBetweenCalls
        ? { value: global.minSecondsBetweenCalls, origin: 'safety_cap' } as EffectiveCampaignValue<number>
        : { value: requestedMinimum, origin: 'campaign_override' } as EffectiveCampaignValue<number>,
    queueStrategy: campaign.queueStrategy === undefined
      ? { value: global.queueStrategy, origin: 'global_default' } as EffectiveCampaignValue<string>
      : { value: campaign.queueStrategy, origin: 'campaign_override' } as EffectiveCampaignValue<string>,
  };
}

export function canonicalizeCampaignSnapshot(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeCampaignSnapshot);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalizeCampaignSnapshot(entry)]));
  }
  return value;
}

export function hashCampaignSnapshot(snapshot: unknown) {
  return createHash('sha256').update(JSON.stringify(canonicalizeCampaignSnapshot(snapshot))).digest('hex');
}

const flattenSnapshot = (value: unknown, path = '', output: Record<string, unknown> = {}) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) flattenSnapshot(entry, path ? `${path}.${key}` : key, output);
  } else output[path] = value;
  return output;
};

export function diffCampaignSnapshots(before: unknown, after: unknown) {
  const left = flattenSnapshot(canonicalizeCampaignSnapshot(before));
  const right = flattenSnapshot(canonicalizeCampaignSnapshot(after));
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
    .filter((path) => JSON.stringify(left[path]) !== JSON.stringify(right[path]))
    .map((path) => ({ path, before: left[path], after: right[path] }));
}
