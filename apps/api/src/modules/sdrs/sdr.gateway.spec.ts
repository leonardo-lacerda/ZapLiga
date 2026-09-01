import 'reflect-metadata';
jest.mock('@nestjs/jwt', () => ({ JwtService: class JwtService {} }));
import WebSocket from 'ws';
import { SdrGateway } from './sdr.gateway';

const identity = { userId: 'user-1', tenantId: 'tenant-1', name: 'Lider', platformRole: 'user' };

const makeSocket = () => ({
  readyState: WebSocket.OPEN,
  send: jest.fn(),
  close: jest.fn(),
  on: jest.fn(),
});

describe('SdrGateway operations observer', () => {
  it('sends a snapshot only to an authorized leader', async () => {
    const socket = makeSocket();
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ role: 'leader' }] }) };
    const dialer = { getOperationsSnapshot: jest.fn().mockResolvedValue({ generated_at: '2026-09-01T12:00:00.000Z' }) };
    const gateway = new SdrGateway(db as any, {} as any, dialer as any);

    await (gateway as any).handleOperations(socket, identity);

    expect(dialer.getOperationsSnapshot).toHaveBeenCalledWith('tenant-1');
    expect(socket.send).toHaveBeenNthCalledWith(1, JSON.stringify({ type: 'operations_connected' }));
    expect(socket.send).toHaveBeenNthCalledWith(2, JSON.stringify({ type: 'operations_snapshot', snapshot: { generated_at: '2026-09-01T12:00:00.000Z' } }));
  });

  it('rejects an SDR from the observer channel', async () => {
    const socket = makeSocket();
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ role: 'sdr' }] }) };
    const dialer = { getOperationsSnapshot: jest.fn() };
    const gateway = new SdrGateway(db as any, {} as any, dialer as any);

    await (gateway as any).handleOperations(socket, identity);

    expect(socket.close).toHaveBeenCalledWith(1008, 'somente lideres podem observar a operacao');
    expect(dialer.getOperationsSnapshot).not.toHaveBeenCalled();
  });

  it('broadcasts observer events only within the target tenant', () => {
    const first = makeSocket();
    const second = makeSocket();
    const gateway = new SdrGateway({} as any, {} as any, {} as any);
    (gateway as any).operations.set(first, { tenantId: 'tenant-1', userId: 'leader-1' });
    (gateway as any).operations.set(second, { tenantId: 'tenant-2', userId: 'leader-2' });

    gateway.broadcastToOperations({ type: 'operations_changed' }, 'tenant-1');

    expect(first.send).toHaveBeenCalledWith(JSON.stringify({ type: 'operations_changed' }));
    expect(second.send).not.toHaveBeenCalled();
  });
});
