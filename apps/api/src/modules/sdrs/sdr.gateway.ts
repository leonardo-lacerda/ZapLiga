import { Inject, Injectable, Logger, OnModuleDestroy, forwardRef } from '@nestjs/common';
import { Server } from 'node:http';
import { URL } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { DialerService } from '../dialer/dialer.service';

@Injectable()
export class SdrGateway implements OnModuleDestroy {
  private readonly logger = new Logger(SdrGateway.name);
  private readonly controls = new Map<string, WebSocket>();
  private readonly sessions = new Map<WebSocket, string>();
  private server?: WebSocketServer;

  constructor(private readonly db: DatabaseService, @Inject(forwardRef(() => DialerService)) private readonly dialer: DialerService) {}

  attach(httpServer: Server) {
    this.server = new WebSocketServer({ noServer: true });
    httpServer.on('upgrade', (request, socket, head) => {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      const control = pathname === '/ws/sdr';
      const match = pathname.match(/^\/ws\/sdr\/([^/]+)\/call\/([^/]+)$/);
      if (!control && !match) return;
      this.server?.handleUpgrade(request, socket, head, (ws) => control ? this.handleControl(ws) : this.handleMedia(ws, decodeURIComponent(match![1]), decodeURIComponent(match![2])));
    });
  }

  onModuleDestroy() { this.server?.close(); }
  isConnected(sdrId: string) { return this.controls.get(sdrId)?.readyState === WebSocket.OPEN; }
  getSocket(sdrId: string) { const socket = this.controls.get(sdrId); return socket?.readyState === WebSocket.OPEN ? socket : undefined; }

  sendToSdr(sdrId: string, message: unknown) {
    const socket = this.controls.get(sdrId);
    if (socket?.readyState === WebSocket.OPEN) { try { socket.send(JSON.stringify(message)); } catch (error) { this.logger.debug(`SDR send skipped: ${String(error)}`); } }
  }

  broadcast(message: unknown) {
    const payload = JSON.stringify(message);
    for (const socket of this.controls.values()) if (socket.readyState === WebSocket.OPEN) { try { socket.send(payload); } catch (error) { this.logger.debug(`SDR broadcast skipped: ${String(error)}`); } }
  }

  private handleControl(socket: WebSocket) {
    socket.on('message', (raw, isBinary) => { if (!isBinary) void this.handleControlMessage(socket, raw.toString()); });
    socket.on('close', () => void this.controlClosed(socket));
    socket.on('error', () => void this.controlClosed(socket));
    try { socket.send(JSON.stringify({ type: 'connected' })); } catch { /* socket closed during handshake */ }
  }

  private async handleControlMessage(socket: WebSocket, raw: string) {
    let message: any;
    try { message = JSON.parse(raw); } catch { try { socket.send(JSON.stringify({ type: 'error', message: 'JSON inválido' })); } catch {} return; }
    try {
      if (message.type === 'identify') {
        const name = String(message.name ?? '').trim();
        if (!name) return socket.send(JSON.stringify({ type: 'error', message: 'Informe o nome do SDR' }));
        const existing = await this.db.query(`INSERT INTO sdrs (id, name, session_id) VALUES ($1, $2, $3) ON CONFLICT (name) DO UPDATE SET session_id = EXCLUDED.session_id RETURNING id, name`, [randomUUID(), name, String(message.sessionId ?? '')]);
        const sdrId = existing.rows[0].id;
        this.controls.set(sdrId, socket); this.sessions.set(socket, sdrId);
        socket.send(JSON.stringify({ type: 'identified', sdr: existing.rows[0] }));
      } else if (message.type === 'availability') {
        const sdrId = this.sessions.get(socket);
        if (sdrId) await this.db.query('UPDATE sdrs SET available = $1 WHERE id = $2', [Boolean(message.available), sdrId]);
      } else if (message.type === 'hangup') {
        await this.dialer.recordOutcome(String(message.callId), 'sdr_hangup');
      } else if (message.type === 'outcome') {
        await this.dialer.recordOutcome(String(message.callId), String(message.outcome ?? 'completed'));
      }
    } catch (error) {
      this.logger.warn(`SDR socket message failed: ${String(error)}`);
      try { socket.send(JSON.stringify({ type: 'error', message: 'Não foi possível processar a mensagem' })); } catch { /* socket closed */ }
    }
  }

  private async controlClosed(socket: WebSocket) {
    const sdrId = this.sessions.get(socket);
    if (!sdrId) return;
    if (this.controls.get(sdrId) === socket) this.controls.delete(sdrId);
    this.sessions.delete(socket);
    await this.db.query('UPDATE sdrs SET available = false WHERE id = $1', [sdrId]);
    await this.dialer.handleSdrDisconnected(sdrId);
  }

  private handleMedia(socket: WebSocket, sdrId: string, callId: string) {
    socket.on('error', () => socket.close());
    void this.dialer.attachMedia(callId, sdrId, socket);
  }
}
