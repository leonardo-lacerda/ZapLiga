export type RecommendationSeverity = 'critical' | 'warning' | 'info';
export type RecommendationStatus = 'active' | 'snoozed' | 'dismissed' | 'resolved' | 'expired';
export type RecommendationEventType = 'impression' | 'opened' | 'snoozed' | 'dismissed' | 'applied' | 'failed' | 'resolved';

export type RecommendationEvidence = {
  summary: string;
  source: 'metrics_summary';
  observedAt: string;
  sampleSize?: number;
};

export type RecommendationAction = {
  label: string;
  description: string;
  type: 'navigate' | 'pause_campaign' | 'start_dialer' | 'reassign_callbacks' | 'disable_number';
  payload: Record<string, unknown>;
};

export type Recommendation = {
  id: string;
  tenantId: string;
  campaignId: string | null;
  code: string;
  scopeKey: string;
  status: RecommendationStatus;
  severity: RecommendationSeverity;
  title: string;
  evidence: RecommendationEvidence;
  recommendedAction: RecommendationAction;
  confidence: number | null;
  impactScope: string;
  ruleVersion: number;
  expiresAt: string | null;
  snoozedUntil: string | null;
  createdAt: string;
  updatedAt: string;
};
