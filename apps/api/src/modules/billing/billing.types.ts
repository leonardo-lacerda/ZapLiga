export type BillingAccessMode = 'full' | 'read_only' | 'blocked';
export type BillingAction = 'read' | 'write' | 'operate' | 'billing_recovery' | 'call_finalize' | 'legal_compliance';
export type FeatureEntitlementLevel = 'none' | 'read_only' | 'basic' | 'full';
export type FeatureEntitlements = Record<string, FeatureEntitlementLevel>;
export type LimitEntitlements = Record<string, number>;

export type TenantAccess = {
  tenantId: string;
  mode: BillingAccessMode;
  reason: string;
  enforcementMode?: 'off' | 'shadow' | 'enforce';
  accessUntil?: string | null;
  planCode?: string | null;
  planName?: string | null;
  maxSdrs?: number | null;
  planMaxSdrs?: number | null;
  includedSdrs?: number | null;
  purchasedExtraSdrs?: number;
  featureEntitlements?: FeatureEntitlements;
  limitEntitlements?: LimitEntitlements;
  lastActiveFeatureEntitlements?: FeatureEntitlements;
  catalogVersion?: number;
  subscriptionQuantityVersion?: number;
  usedSdrSeats?: number;
  reservedSdrSeats?: number;
  cancelAtPeriodEnd?: boolean;
  source?: string;
};

export const mutatingBillingActions = new Set<BillingAction>(['write', 'operate']);
