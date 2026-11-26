import 'reflect-metadata';
jest.mock('@nestjs/jwt', () => ({ JwtService: class JwtService {} }));
import { DialerService } from './dialer.service';
import { lineCanaryPassedSql, lineUnderDailyCapSql } from './dialer.rules';

describe('DialerService canary', () => {
  const gateway = () => ({ isConnected: jest.fn().mockReturnValue(true), getSocket: jest.fn(), sendToSdr: jest.fn(), broadcast: jest.fn(), broadcastToOperations: jest.fn() });
  const redis = () => ({ client: { lpush: jest.fn().mockResolvedValue(1), ltrim: jest.fn().mockResolvedValue('OK') } });

  describe('evaluateCanary', () => {
    const make = (line: Record<string, unknown>, status: Record<string, unknown>) => {
      const db = {
        query: jest.fn(async (sql: string) => {
          if (sql.startsWith('SELECT label')) return { rows: [{ label: 'Previtas 12', waxum_session_id: 's1', loss_reason: null, ...line }] };
          if (sql.includes('UPDATE whatsapp_numbers SET canary_status')) return { rows: [{ id: 'n1' }] };
          return { rows: [] };
        }),
      };
      const waxum = { getStatus: jest.fn(async () => status) };
      const sdrGateway = gateway();
      const service = new DialerService(db as any, redis() as any, waxum as any, sdrGateway as any);
      return { service, db, sdrGateway };
    };
    const canaryUpdate = (db: { query: jest.Mock }) => db.query.mock.calls.find(([sql]: [string]) => sql.includes('UPDATE whatsapp_numbers SET canary_status'));

    it('frees the line when the call lasted and the line is still connected 30 s after the offer', async () => {
      const { service, db, sdrGateway } = make({}, { status: 'connected', is_logged_in: true });

      await (service as any).evaluateCanary('t1', 'call-1', 'n1', 'sdr-1', Date.now() - 31_000);

      expect(canaryUpdate(db)[1]).toEqual(['t1', 'n1', 'passed', 48]);
      expect(sdrGateway.sendToSdr).toHaveBeenCalledWith('sdr-1', expect.objectContaining({ type: 'canary_result', result: 'passed' }));
    });

    it('rests the line when WhatsApp removed it during the canary', async () => {
      jest.useFakeTimers();
      try {
        const { service, db } = make({ loss_reason: 'device_removed' }, { status: 'disconnected' });
        const pending = (service as any).evaluateCanary('t1', 'call-1', 'n1', 'sdr-1', Date.now() - 3_000);
        await jest.advanceTimersByTimeAsync(30_000);
        await pending;
        expect(canaryUpdate(db)[1]).toEqual(['t1', 'n1', 'failed', 48]);
      } finally { jest.useRealTimers(); }
    });

    it('decides nothing when the call never reached the offer', async () => {
      const { service, db, sdrGateway } = make({}, {});

      await (service as any).evaluateCanary('t1', 'call-1', 'n1', 'sdr-1', undefined);

      expect(canaryUpdate(db)).toBeUndefined();
      expect(sdrGateway.sendToSdr).toHaveBeenCalledWith('sdr-1', expect.objectContaining({ result: 'not_dialed' }));
    });
  });

  it('only lets a canary dial a team phone from a chosen line', async () => {
    const db = { query: jest.fn(async (sql: string) => (sql.includes('FROM dialer_settings') ? { rows: [{ canary_phones: ['5527999990000'] }] } : { rows: [] })) };
    const service = new DialerService(db as any, redis() as any, {} as any, gateway() as any);

    await expect(service.manualCallWithInput({ phone: '5527988887777', numberId: 'n1', canary: true }, 't1')).rejects.toThrow('celular da equipe');
    await expect(service.manualCallWithInput({ phone: '5527999990000', canary: true }, 't1')).rejects.toThrow('celular da equipe');
  });

  it('keeps lines without a passed canary, and young lines over the daily cap, away from leads', () => {
    expect(lineCanaryPassedSql('n')).toBe("n.canary_status = 'passed'");
    const cap = lineUnderDailyCapSql('n');
    expect(cap).toContain("n.last_paired_at < now() - interval '7 days'");
    expect(cap).toContain('c.number_id = n.id');
    expect(cap).toContain(') < 60)');
  });
});
