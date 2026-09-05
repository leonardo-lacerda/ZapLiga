export const ANALYTICS_EVENT_SCHEMA_VERSION = 1 as const;

const catalog = {
  'campaign.created': ['campaignId', 'duplicatedFrom'],
  'campaign.updated': ['campaignId', 'lockVersion'],
  'campaign.version_published': ['campaignId', 'version'],
  'campaign.started': ['from', 'to'],
  'campaign.paused': ['from', 'to'],
  'campaign.completed': ['from', 'to'],
  'campaign.archived': ['from', 'to'],
  'campaign.playbook_created': ['sourceCampaignId'],
  'campaign.integration_attached': ['integrationId', 'campaignId'],
  'campaign.integration_detached': ['integrationId', 'campaignId'],
  'lead.received': ['eventId', 'status', 'campaignId', 'campaignVersion'],
  'lead.eligible': ['leadId', 'campaignId', 'campaignVersion'],
  'lead.suppressed': ['leadId', 'reasonCode'],
  'decision.scored': ['leadId', 'score', 'policyVersion', 'reasonCodes'],
  'decision.selected': ['leadId', 'score', 'policyVersion'],
  'call.reserved': ['leadId', 'sdrId', 'numberId', 'campaignId', 'campaignVersion', 'source'],
  'call.connected': ['leadId', 'sdrId', 'numberId', 'campaignId', 'campaignVersion'],
  'call.ended': ['status', 'outcome', 'campaignId', 'campaignVersion'],
  'wrap_up.completed': ['callId', 'callResult', 'pipelineStage'],
  'callback.created': ['callbackId', 'callId', 'sdrId'],
  'callback.completed': ['callbackId', 'callId', 'sdrId'],
  'stage.changed': ['fromStage', 'toStage', 'callId'],
  'health.changed': ['score', 'state', 'formulaVersion'],
  'recommendation.applied': ['recommendationId', 'actionType'],
} as const;

export const ANALYTICS_EVENT_CATALOG = Object.freeze(catalog);
export type AnalyticsEventType = keyof typeof ANALYTICS_EVENT_CATALOG;

const isPrimitive = (value: unknown): value is string | number | boolean | null =>
  value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

const safeValue = (value: unknown) => {
  if (isPrimitive(value)) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 32).filter(isPrimitive);
  return undefined;
};

/**
 * Keeps the analytics contract intentionally narrower than the operational
 * domain. Unknown fields are dropped so names, phones, notes and free text do
 * not become an accidental shared dataset.
 */
export function sanitizeAnalyticsPayload(eventType: string, payload: Record<string, unknown> = {}) {
  const fields = ANALYTICS_EVENT_CATALOG[eventType as AnalyticsEventType];
  if (!fields) throw new Error(`Evento analítico não catalogado: ${eventType}`);
  const allowed = new Set<string>(fields);
  return Object.fromEntries(Object.entries(payload)
    .filter(([key]) => allowed.has(key))
    .map(([key, value]) => [key, safeValue(value)] as const)
    .filter(([, value]) => value !== undefined));
}

export function analyticsCatalog() {
  return Object.entries(ANALYTICS_EVENT_CATALOG).map(([eventType, fields]) => ({
    eventType,
    schemaVersion: ANALYTICS_EVENT_SCHEMA_VERSION,
    fields: [...fields],
  }));
}
