export type PlatformRole = 'user' | 'super_admin';
export type TenantRole = 'leader' | 'sdr';

export type TenantAccessContext = {
  tenantId: string;
  mode: 'full' | 'read_only' | 'blocked';
  reason: string;
  enforcementMode?: 'off' | 'shadow' | 'enforce';
  accessUntil?: string | null;
  planCode?: string | null;
  planName?: string | null;
  maxSdrs?: number | null;
  planMaxSdrs?: number | null;
  usedSdrSeats?: number;
  reservedSdrSeats?: number;
  cancelAtPeriodEnd?: boolean;
  source?: string;
};

export type AuthenticatedUser = {
  id: string;
  platformRole: PlatformRole;
  sessionId: string;
  tenantMembership?: { tenantId: string; role: TenantRole; status: string };
  tenantAccess?: TenantAccessContext;
};
