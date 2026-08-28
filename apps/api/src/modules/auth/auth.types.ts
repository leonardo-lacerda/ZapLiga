export type PlatformRole = 'user' | 'super_admin';
export type TenantRole = 'leader' | 'sdr';

export type AuthenticatedUser = {
  id: string;
  platformRole: PlatformRole;
  sessionId: string;
  tenantMembership?: { tenantId: string; role: TenantRole; status: string };
};
