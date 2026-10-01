/**
 * Who may run a calling station. SDRs always could; leaders and platform admins now can too,
 * without changing their role -- they just get an operator row (`sdrs`) tagged with their kind.
 * Seats are counted from `tenant_memberships role='sdr'`, so these rows never consume one.
 */
export type OperatorKind = 'sdr' | 'leader' | 'platform_admin';

export const operatorKindFor = (user: { platformRole?: string; tenantMembership?: { role?: string } }): OperatorKind | null => {
  if (user.platformRole === 'super_admin') return 'platform_admin';
  const role = user.tenantMembership?.role;
  if (role === 'leader') return 'leader';
  if (role === 'sdr') return 'sdr';
  return null;
};

/**
 * SQL predicate: the operator row `alias` still belongs to someone allowed to take calls. A row
 * outlives role changes (an SDR promoted to leader, an admin demoted), so eligibility is checked
 * against the person's CURRENT role every time instead of trusting the row alone.
 */
export const eligibleOperatorSql = (alias = 's') => `(
  (${alias}.operator_kind = 'sdr' AND EXISTS (SELECT 1 FROM tenant_memberships tm WHERE tm.tenant_id = ${alias}.tenant_id AND tm.user_id = ${alias}.user_id AND tm.role = 'sdr' AND tm.status = 'active'))
  OR (${alias}.operator_kind = 'leader' AND EXISTS (SELECT 1 FROM tenant_memberships tm WHERE tm.tenant_id = ${alias}.tenant_id AND tm.user_id = ${alias}.user_id AND tm.role = 'leader' AND tm.status = 'active'))
  OR (${alias}.operator_kind = 'platform_admin' AND EXISTS (SELECT 1 FROM users pu WHERE pu.id = ${alias}.user_id AND pu.platform_role = 'super_admin' AND pu.status = 'active'))
)`;

/** Operators that belong in a tenant's own reports: a platform admin calling for support is not. */
export const tenantOperatorSql = (alias = 's') => `${alias}.operator_kind <> 'platform_admin'`;
