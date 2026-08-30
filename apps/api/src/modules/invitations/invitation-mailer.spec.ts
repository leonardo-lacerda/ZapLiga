import { InvitationMailer, InvitationMessage } from './invitation-mailer';

describe('InvitationMailer', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const message: InvitationMessage = { email: 'sdr@example.com', tenantName: 'Acme', role: 'leader', invitationUrl: 'https://app.example.com/convite/abc' };

  const makeMailer = (resend?: { emails: { send: jest.Mock } }) => {
    const mailer = Object.create(InvitationMailer.prototype) as any;
    mailer.logger = { log: jest.fn() };
    mailer.resend = resend;
    return mailer as InvitationMailer;
  };

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it('sends through Resend when a client is configured', async () => {
    const send = jest.fn().mockResolvedValue({ error: null });
    const mailer = makeMailer({ emails: { send } });

    await mailer.send(message);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual(expect.objectContaining({ to: 'sdr@example.com', subject: expect.stringContaining('Acme') }));
  });

  it('throws when Resend reports a delivery error', async () => {
    const send = jest.fn().mockResolvedValue({ error: { message: 'domain not verified' } });
    const mailer = makeMailer({ emails: { send } });

    await expect(mailer.send(message)).rejects.toThrow('domain not verified');
  });

  it('logs without sending outside production when no client is configured', async () => {
    process.env.NODE_ENV = 'development';
    const mailer = makeMailer(undefined);

    await expect(mailer.send(message)).resolves.toBeUndefined();
  });

  it('throws in a real deployment when no client is configured', async () => {
    process.env.NODE_ENV = 'production';
    const mailer = makeMailer(undefined);

    await expect(mailer.send(message)).rejects.toThrow('RESEND_API_KEY');
  });
});
