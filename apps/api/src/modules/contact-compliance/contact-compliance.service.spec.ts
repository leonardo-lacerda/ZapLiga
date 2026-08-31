import 'reflect-metadata';
import { ContactComplianceService, normalizeContactPhone } from './contact-compliance.service';

describe('ContactComplianceService', () => {
  it('normalizes a phone without retaining formatting', () => {
    expect(normalizeContactPhone('+55 (11) 99999-0000')).toBe('5511999990000');
  });

  it('creates a canonical suppression, projects it to leads and records the immutable event', async () => {
    const client = { query: jest.fn(async (sql: string, params: any[]) => {
      if (sql.startsWith('SELECT * FROM contact_suppressions')) return { rows: [] };
      if (sql.includes('INSERT INTO contact_suppressions')) return { rows: [{ id: params[0], tenant_id: params[1], phone: params[2], reason: params[3], source: params[4] }] };
      return { rows: [] };
    }) };
    const db = { transaction: jest.fn(async (callback: any) => callback(client)), query: jest.fn() };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new ContactComplianceService(db as any, audit as any);

    const result = await service.suppress({ tenantId: 'tenant-1', phone: '(11) 99999-0000', reason: 'requested_opt_out', source: 'lead_action', actorUserId: 'user-1' });

    expect(result).toEqual(expect.objectContaining({ phone: '11999990000', alreadyExisted: false }));
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE leads SET do_not_call = true'), ['tenant-1', '11999990000']);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('contact_compliance_events'), expect.arrayContaining(['tenant-1', '11999990000', 'lead_action']));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'contact.suppressed', tenantId: 'tenant-1' }));
  });

  it('is idempotent when the phone is already actively suppressed', async () => {
    const existing = { id: 'suppression-1', tenant_id: 'tenant-1', phone: '5511999990000', reason: 'requested_opt_out' };
    const client = { query: jest.fn(async (sql: string) => sql.startsWith('SELECT * FROM contact_suppressions') ? { rows: [existing] } : { rows: [] }) };
    const db = { transaction: jest.fn(async (callback: any) => callback(client)), query: jest.fn() };
    const service = new ContactComplianceService(db as any, { record: jest.fn() } as any);

    const result = await service.suppress({ tenantId: 'tenant-1', phone: existing.phone, reason: 'requested_opt_out', source: 'api' });

    expect(result.alreadyExisted).toBe(true);
    expect(client.query.mock.calls.filter((call: any[]) => call[0].includes('INSERT INTO contact_suppressions'))).toHaveLength(0);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE leads SET do_not_call = true'), ['tenant-1', existing.phone]);
  });

  it('lifts a suppression with a reason and recomputes the lead projection', async () => {
    const suppression = { id: 'suppression-1', tenant_id: 'tenant-1', phone: '5511999990000', lifted_at: null };
    const client = { query: jest.fn(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM contact_suppressions')) return { rows: [suppression] };
      if (sql.startsWith('UPDATE contact_suppressions')) return { rows: [{ ...suppression, lifted_at: new Date().toISOString() }] };
      return { rows: [] };
    }) };
    const db = { transaction: jest.fn(async (callback: any) => callback(client)), query: jest.fn() };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new ContactComplianceService(db as any, audit as any);

    await service.lift('tenant-1', 'suppression-1', 'Autorização documentada', 'leader-1');

    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('do_not_call = EXISTS'), ['tenant-1', suppression.phone]);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'contact.suppression_lifted' }));
  });
});

