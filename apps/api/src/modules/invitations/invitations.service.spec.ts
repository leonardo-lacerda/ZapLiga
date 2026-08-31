import { InvitationsService } from './invitations.service';

describe('InvitationsService email delivery with fallback links', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalWebOrigin = process.env.WEB_ORIGIN;

  const makeService = () => {
    const service = Object.create(InvitationsService.prototype) as any;
    service.invitationTtlSeconds = 172800;
    service.db = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    service.tenants = { requireById: jest.fn().mockResolvedValue({ id: 'tenant-1', name: 'Acme' }) };
    service.users = { findByEmail: jest.fn().mockResolvedValue(null) };
    service.memberships = { findForUserInTenant: jest.fn().mockResolvedValue(null) };
    service.audit = { record: jest.fn().mockResolvedValue(undefined) };
    service.mailer = { send: jest.fn().mockResolvedValue(undefined) };
    return service;
  };

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalWebOrigin === undefined) delete process.env.WEB_ORIGIN;
    else process.env.WEB_ORIGIN = originalWebOrigin;
  });

  it('emails an SDR invitation and returns its fallback link', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WEB_ORIGIN = 'https://app.example.com';
    const service = makeService();

    const result = await service.createSdrInvitation('tenant-1', 'leader-1', 'sdr@example.com', 'SDR Example');

    expect(result.role).toBe('sdr');
    expect(result.invitationUrl).toMatch(/^https:\/\/app\.example\.com\/convite\//);
    expect(service.mailer.send).toHaveBeenCalledTimes(1);
    expect(service.audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'sdr.invitation.created',
      metadata: expect.objectContaining({ delivery: 'email' }),
    }));
  });

  it('keeps a copyable fallback for generic invitations', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WEB_ORIGIN = 'https://app.example.com';
    const service = makeService();

    const result = await service.create('tenant-1', 'admin-1', 'leader@example.com', 'leader');

    expect(result.invitationUrl).toMatch(/^https:\/\/app\.example\.com\/convite\//);
    expect(service.mailer.send).toHaveBeenCalledTimes(1);
  });

  it('queues a provider failure for a durable retry without exposing the token', async () => {
    const service = makeService();
    service.mailer.send.mockRejectedValue(new Error('provider unavailable'));
    const result = await service.create('tenant-1', 'admin-1', 'retry@example.com', 'leader');
    expect(result.invitationUrl).toContain('/convite/');
    expect(service.db.query).toHaveBeenCalledWith(expect.stringContaining("delivery_status = CASE"), expect.arrayContaining([expect.any(String), 'provider unavailable']));
  });
});

describe('InvitationsService multitenant acceptance', () => {
  it('adds a membership to an existing account after checking its password', async () => {
    const invitation = { id: 'inv-1', tenant_id: 'tenant-b', tenant_name: 'Tenant B', tenant_status: 'active', invited_email: 'user@example.com', role: 'leader', expires_at: new Date(Date.now() + 60_000).toISOString() };
    const existingUser = { id: 'user-1', email: invitation.invited_email, password_hash: 'hash', name: 'User' };
    const client = { query: jest.fn(async (sql: string) => {
      if (sql.includes('FROM invitations')) return { rows: [invitation] };
      if (sql.includes('FROM users')) return { rows: [existingUser] };
      if (sql.includes('INSERT INTO tenant_memberships')) return { rows: [{ id: 'member-1', tenant_id: 'tenant-b', user_id: 'user-1', role: 'leader' }] };
      return { rows: [] };
    }) };
    const service = Object.create(InvitationsService.prototype) as any;
    service.db = { transaction: jest.fn(async (callback: any) => callback(client)) };
    service.users = { hashPassword: jest.fn().mockResolvedValue('new-hash'), comparePassword: jest.fn().mockResolvedValue(true) };
    service.audit = { record: jest.fn().mockResolvedValue(undefined) };

    const result = await service.accept('token', 'User', 'correct-password');

    expect(result.user.id).toBe('user-1');
    expect(service.users.comparePassword).toHaveBeenCalledWith('correct-password', 'hash');
    expect(client.query.mock.calls.some(([sql]: [string]) => sql.includes('INSERT INTO users'))).toBe(false);
  });
});
