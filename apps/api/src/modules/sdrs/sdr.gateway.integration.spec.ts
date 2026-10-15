import 'reflect-metadata';
jest.mock('@nestjs/jwt', () => ({ JwtService: class JwtService {} }));
import WebSocket from 'ws';
import { SdrGateway } from './sdr.gateway';
import { DialRefusedError } from '../dialer/dial-intents';

const crmIdentity = { userId: 'user-1', tenantId: 'tenant-1', name: 'Ana', platformRole: 'user', integrationId: 'int-1' };
const panelIdentity = { ...crmIdentity, integrationId: null };

const makeSocket = () => ({ readyState: WebSocket.OPEN, send: jest.fn(), close: jest.fn(), on: jest.fn() });
const sent = (socket: ReturnType<typeof makeSocket>) => socket.send.mock.calls.map(([payload]) => JSON.parse(payload));

const makeGateway = (dialer: any = {}) => {
  const db = {
    query: jest.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('SELECT 1 FROM tenant_memberships')) return { rows: [{ 1: 1 }] };
      if (sql.includes('SELECT role FROM tenant_memberships')) return { rows: [{ role: 'sdr' }] };
      if (sql.includes('FROM sdrs') && sql.includes('user_id = $2')) return { rows: [{ id: 'sdr-1' }] };
      if (sql.includes('UPDATE sdrs SET user_id')) return { rows: [{ id: 'sdr-1', name: 'Ana', available: false, state: 'offline', current_pause_id: null, station_mode: 'manual_only' }] };
      return { rows: [] };
    }),
  };
  const gateway = new SdrGateway(db as any, {} as any, { getSdrState: jest.fn().mockResolvedValue({}), setAvailability: jest.fn(), ...dialer } as any);
  return { gateway, db };
};

describe('SdrGateway CRM integration stations', () => {
  it('marks a station opened with an integration ticket as manual-only', async () => {
    const { gateway, db } = makeGateway();
    const socket = makeSocket();
    await (gateway as any).handleControlMessage(socket, JSON.stringify({ type: 'identify' }), crmIdentity);
    const update = db.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE sdrs SET user_id'));
    expect(update?.[1]).toContain('manual_only');
    expect(sent(socket)[0]).toMatchObject({ type: 'identified' });
  });

  it('never lets a manual-only station join the automatic queue', async () => {
    const setAvailability = jest.fn();
    const { gateway } = makeGateway({ setAvailability });
    const socket = makeSocket();
    await (gateway as any).handleControlMessage(socket, JSON.stringify({ type: 'identify' }), crmIdentity);
    await (gateway as any).handleControlMessage(socket, JSON.stringify({ type: 'availability', available: true }), crmIdentity);
    expect(setAvailability).not.toHaveBeenCalled();
    expect(sent(socket).at(-1)).toMatchObject({ type: 'error', code: 'manual_only_station' });
  });

  it('redeems a dial intent and replies with the call id', async () => {
    const dialFromIntent = jest.fn().mockResolvedValue({ callId: 'call-1', leadId: 'lead-1' });
    const { gateway } = makeGateway({ dialFromIntent });
    const socket = makeSocket();
    await (gateway as any).handleControlMessage(socket, JSON.stringify({ type: 'identify' }), crmIdentity);
    await (gateway as any).handleControlMessage(socket, JSON.stringify({ type: 'dial', intentId: 'intent-1' }), crmIdentity);
    expect(dialFromIntent).toHaveBeenCalledWith('intent-1', 'sdr-1', 'tenant-1');
    expect(sent(socket).at(-1)).toEqual({ intentId: 'intent-1', type: 'dial_accepted', callId: 'call-1', leadId: 'lead-1' });
  });

  it('reports refusals with their code instead of the generic socket error', async () => {
    const dialFromIntent = jest.fn().mockRejectedValue(new DialRefusedError('line_protected', 'Linha protegida', 30));
    const { gateway } = makeGateway({ dialFromIntent });
    const socket = makeSocket();
    await (gateway as any).handleControlMessage(socket, JSON.stringify({ type: 'identify' }), crmIdentity);
    await (gateway as any).handleControlMessage(socket, JSON.stringify({ type: 'dial', intentId: 'intent-1' }), crmIdentity);
    expect(sent(socket).at(-1)).toMatchObject({ type: 'dial_failed', code: 'line_protected', retryAfterSeconds: 30 });
  });

  it('does not accept dial from a panel station', async () => {
    const dialFromIntent = jest.fn();
    const { gateway } = makeGateway({ dialFromIntent });
    const socket = makeSocket();
    await (gateway as any).handleControlMessage(socket, JSON.stringify({ type: 'identify' }), panelIdentity);
    await (gateway as any).handleControlMessage(socket, JSON.stringify({ type: 'dial', intentId: 'intent-1' }), panelIdentity);
    expect(dialFromIntent).not.toHaveBeenCalled();
    expect(sent(socket).at(-1)).toMatchObject({ type: 'dial_failed', code: 'not_integration_station' });
  });

  it('only opens integration stations from declared origins of an active integration', async () => {
    const query = jest.fn();
    const gateway = new SdrGateway({ query } as any, {} as any, {} as any);
    query.mockResolvedValueOnce({ rows: [{ status: 'active', allowed_origins: ['https://franco.example.com'] }] });
    await expect((gateway as any).integrationAllowsOrigin('int-1', 'https://franco.example.com/')).resolves.toBe(true);
    query.mockResolvedValueOnce({ rows: [{ status: 'active', allowed_origins: ['https://franco.example.com'] }] });
    await expect((gateway as any).integrationAllowsOrigin('int-1', 'https://evil.example.com')).resolves.toBe(false);
    query.mockResolvedValueOnce({ rows: [{ status: 'revoked', allowed_origins: [] }] });
    await expect((gateway as any).integrationAllowsOrigin('int-1', 'https://franco.example.com')).resolves.toBe(false);
    query.mockResolvedValueOnce({ rows: [{ status: 'active', allowed_origins: [] }] });
    await expect((gateway as any).integrationAllowsOrigin('int-1', undefined)).resolves.toBe(true);
  });
});
