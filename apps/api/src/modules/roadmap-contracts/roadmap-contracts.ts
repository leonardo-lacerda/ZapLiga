export const CAMPAIGN_STATUSES = ['draft', 'ready', 'running', 'paused', 'completed', 'archived'] as const;
export type CampaignStatus = typeof CAMPAIGN_STATUSES[number];

export const DECISION_MODES = ['disabled', 'shadow', 'active'] as const;
export type DecisionMode = typeof DECISION_MODES[number];

export const RECOMMENDATION_SEVERITIES = ['info', 'opportunity', 'warning', 'critical'] as const;
export const RECOMMENDATION_STATUSES = ['open', 'snoozed', 'dismissed', 'applied', 'resolved', 'expired'] as const;
export const OPERATION_HEALTH_STATES = ['insufficient_data', 'healthy', 'attention', 'degraded', 'blocked'] as const;

export const ROADMAP_REASON_CODES = [
  'within_schedule',
  'outside_schedule',
  'not_suppressed',
  'contact_suppressed',
  'attempt_budget_ok',
  'attempt_budget_exhausted',
  'callback_due',
  'callback_owned_by_another_sdr',
  'recent_inbound',
  'previous_attempts',
  'queue_fairness',
  'line_connected',
  'line_disconnected',
  'line_cooldown',
  'line_quarantined',
  'line_protected',
  'rate_limit_reached',
  'sdr_available',
  'no_sdr_available',
  'folder_active',
  'folder_inactive',
  'lead_status_eligible',
  'lead_status_ineligible',
  'next_attempt_due',
  'next_attempt_wait',
  'callback_pending',
  'active_call',
  'no_active_call',
  'self_call',
  'manual_queue_override',
  'score_priority',
  'lead_age',
  'historical_signal',
  'campaign_running',
  'campaign_not_running',
  'insufficient_sample',
] as const;
export type RoadmapReasonCode = typeof ROADMAP_REASON_CODES[number];

export const ROADMAP_EVENT_TYPES = [
  'campaign.created',
  'campaign.updated',
  'campaign.version_published',
  'campaign.started',
  'campaign.paused',
  'campaign.completed',
  'campaign.archived',
  'campaign.playbook_created',
  'campaign.integration_attached',
  'campaign.integration_detached',
  'lead.received',
  'lead.eligible',
  'lead.suppressed',
  'decision.scored',
  'decision.selected',
  'call.reserved',
  'call.connected',
  'call.ended',
  'wrap_up.completed',
  'callback.created',
  'callback.completed',
  'stage.changed',
  'health.changed',
  'recommendation.applied',
] as const;
export type RoadmapEventType = typeof ROADMAP_EVENT_TYPES[number];

export const ROADMAP_CONTRACT_VERSION = 1 as const;
