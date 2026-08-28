import { InvitationsService } from './invitations.service';

describe('InvitationsService manual SDR links', () => {
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

  it('creates a SDR link in production without sending email', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WEB_ORIGIN = 'https://app.example.com';
    const service = makeService();

    const result = await service.createSdrInvitation('tenant-1', 'leader-1', 'sdr@example.com', 'SDR Example');

    expect(result.role).toBe('sdr');
    expect(result.invitationUrl).toMatch(/^https:\/\/app\.example\.com\/app\/invite\//);
    expect(service.mailer.send).not.toHaveBeenCalled();
    expect(service.audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'sdr.invitation.created',
      metadata: expect.objectContaining({ delivery: 'manual_link' }),
    }));
  });

  it('keeps email delivery for generic invitations', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WEB_ORIGIN = 'https://app.example.com';
    const service = makeService();

    const result = await service.create('tenant-1', 'admin-1', 'leader@example.com', 'leader');

    expect(result.invitationUrl).toBeUndefined();
    expect(service.mailer.send).toHaveBeenCalledTimes(1);
  });
});
