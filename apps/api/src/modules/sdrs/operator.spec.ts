import { eligibleOperatorSql, operatorKindFor, tenantOperatorSql } from './operator';

describe('operator identity', () => {
  it('maps the caller to the kind of operator row they get', () => {
    expect(operatorKindFor({ platformRole: 'super_admin', tenantMembership: { role: 'leader' } })).toBe('platform_admin');
    expect(operatorKindFor({ platformRole: 'user', tenantMembership: { role: 'leader' } })).toBe('leader');
    expect(operatorKindFor({ platformRole: 'user', tenantMembership: { role: 'sdr' } })).toBe('sdr');
    expect(operatorKindFor({ platformRole: 'user' })).toBeNull();
  });

  it('checks every kind against the person\'s current role, and keeps admins out of tenant reports', () => {
    const sql = eligibleOperatorSql('x');
    expect(sql).toContain("x.operator_kind = 'sdr'");
    expect(sql).toContain("tm.role = 'leader'");
    expect(sql).toContain("pu.platform_role = 'super_admin'");
    expect(tenantOperatorSql('x')).toBe("x.operator_kind <> 'platform_admin'");
  });
});
