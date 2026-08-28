import { Inject, Injectable, Logger, OnModuleDestroy, forwardRef } from '@nestjs/common';
import { Server } from 'node:http';
import { URL } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { DialerService } from '../dialer/dialer.service';
import { legacyTenantId } from '../../database/tenant-context';
import { AuthService } from '../auth/auth.service';

@Injectable()
export class SdrGateway implements OnModuleDestroy {
  private readonly logger = new Logger(SdrGateway.name);
  private readonly controls = new Map<string, WebSocket>();
  private readonly sessions = new Map<WebSocket, string>();
  private readonly tenantBySdr = new Map<string, string>();
  private server?: WebSocketServer;

  constructor(private readonly db: DatabaseService, private readonly auth: AuthService, @Inject(forwardRef(() => DialerService)) private readonly dialer: DialerService) {}

  attach(httpServer: Server) {
    this.server = new WebSocketServer({ noServer: true });
    httpServer.on('upgrade', (request, socket, head) => {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      const url = new URL(request.url ?? '/', 'http://localhost');
      const scopedControl = pathname.match(/^\/ws\/tenants\/([^/]+)\/sdr$/);
      const scopedMedia = pathname.match(/^\/ws\/tenants\/([^/]+)\/sdr\/([^/]+)\/call\/([^/]+)$/);
      const legacyMedia = pathname.match(/^\/ws\/sdr\/([^/]+)\/call\/([^/]+)$/);
      const control = pathname === '/ws/sdr' || Boolean(scopedControl);
      const media = scopedMedia ?? legacyMedia;
      if (!control && !media) return;
      const ticket = url.searchParams.get('ticket');
      if (!ticket) { socket.destroy(); return; }
      void this.auth.consumeWebsocketTicket(ticket).then((identity) => {
        if (!identity) { socket.destroy(); return; }
        const requestedTenant = scopedControl?.[1] ?? scopedMedia?.[1];
        if (requestedTenant && decodeURIComponent(requestedTenant) !== identity.tenantId) { socket.destroy(); return; }
        const mediaSdrId = scopedMedia?.[2] ?? legacyMedia?.[1];
        const mediaCallId = scopedMedia?.[3] ?? legacyMedia?.[2];
        this.server?.handleUpgrade(request, socket, head, (ws) => control ? this.handleControl(ws, identity) : this.handleMedia(ws, decodeURIComponent(mediaSdrId!), decodeURIComponent(mediaCallId!), identity));
      }).catch(() => socket.destroy());
    });
  }

  onModuleDestroy() { this.server?.close(); }
  isConnected(sdrId: string) { return this.controls.get(sdrId)?.readyState === WebSocket.OPEN; }
  getSocket(sdrId: string) { const socket = this.controls.get(sdrId); return socket?.readyState === WebSocket.OPEN ? socket : undefined; }

  sendToSdr(sdrId: string, message: unknown) {
    const socket = this.controls.get(sdrId);
    if (socket?.readyState === WebSocket.OPEN) { try { socket.send(JSON.stringify(message)); } catch (error) { this.logger.debug(`SDR send skipped: ${String(error)}`); } }
  }

  broadcast(message: unknown, tenantId = legacyTenantId()) {
    const payload = JSON.stringify(message);
    for (const [sdrId, socket] of this.controls.entries()) {
      if (this.tenantBySdr.get(sdrId) !== tenantId) continue;
      if (socket.readyState === WebSocket.OPEN) { try { socket.send(payload); } catch (error) { this.logger.debug(`SDR broadcast skipped: ${String(error)}`); } }
    }
  }

  private handleControl(socket: WebSocket, identity: { userId: string; tenantId: string; name: string; platformRole: string }) {
    socket.on('message', (raw, isBinary) => { if (!isBinary) void this.handleControlMessage(socket, raw.toString(), identity); });
    socket.on('close', () => void this.controlClosed(socket));
    socket.on('error', () => void this.controlClosed(socket));
    try { socket.send(JSON.stringify({ type: 'connected' })); } catch { /* socket closed during handshake */ }
  }

  private async handleControlMessage(socket: WebSocket, raw: string, identity: { userId: string; tenantId: string; name: string; platformRole: string }) {
    let message: any;
    try { message = JSON.parse(raw); } catch { try { socket.send(JSON.stringify({ type: 'error', message: 'JSON inválido' })); } catch {} return; }
    try {
      if (message.type === 'identify') {
        if (identity.platformRole !== 'super_admin') {
          const membership = await this.db.query(`SELECT role FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1`, [identity.tenantId, identity.userId]);
          if (membership.rows[0]?.role !== 'sdr') throw new Error('Somente usuários SDR podem abrir o canal operacional');
        }
        const name = identity.name.trim();
        const requestedId = String(message.sdrId ?? '').trim();
        const existing = await this.db.query(`
          SELECT id, name, available, state, current_pause_id
          FROM sdrs
          WHERE tenant_id = $1 AND (user_id = $2 OR (id = $3 AND user_id IS NULL AND name = $4) OR (name = $4 AND user_id IS NULL))
          ORDER BY (user_id = $2) DESC
          LIMIT 1
        `, [identity.tenantId, identity.userId, requestedId, name]);
        const sdr = existing.rows[0] ?? (await this.db.query(`
          INSERT INTO sdrs (id, tenant_id, user_id, name, session_id) VALUES ($1, $2, $3, $4, $5)
          RETURNING id, name, available, state, current_pause_id
        `, [randomUUID(), identity.tenantId, identity.userId, name, String(message.sessionId ?? '')])).rows[0];
        const claimed = await this.db.query(`
          UPDATE sdrs SET user_id = $1, session_id = $2
          WHERE tenant_id = $3 AND id = $4
          RETURNING id, name, available, state, current_pause_id
        `, [identity.userId, String(message.sessionId ?? ''), identity.tenantId, sdr.id]);
        const sdrId = claimed.rows[0].id;
        const tenantId = identity.tenantId;
        this.controls.set(sdrId, socket); this.sessions.set(socket, sdrId); this.tenantBySdr.set(sdrId, tenantId);
        const state = await this.dialer.getSdrState(sdrId, tenantId);
        socket.send(JSON.stringify({ type: 'identified', sdr: { ...claimed.rows[0], ...state } }));
      } else if (message.type === 'availability') {
        const sdrId = this.sessions.get(socket);
        if (sdrId) {
          const state = await this.dialer.setAvailability(sdrId, Boolean(message.available), this.tenantBySdr.get(sdrId) ?? legacyTenantId());
          socket.send(JSON.stringify({ type: 'availability_changed', available: Boolean(message.available), sdr: state }));
        }
      } else if (message.type === 'hangup') {
        const sdrId = this.sessions.get(socket);
        if (!sdrId) throw new Error('Socket ainda não identificado');
        await this.dialer.recordOutcome(String(message.callId), 'sdr_hangup', this.tenantBySdr.get(sdrId) ?? legacyTenantId(), sdrId);
      } else if (message.type === 'outcome') {
        const sdrId = this.sessions.get(socket);
        if (!sdrId) throw new Error('Socket ainda não identificado');
        await this.dialer.recordOutcome(String(message.callId), String(message.outcome ?? 'completed'), this.tenantBySdr.get(sdrId) ?? legacyTenantId(), sdrId);
      }
    } catch (error) {
      this.logger.warn(`SDR socket message failed: ${String(error)}`);
      try { socket.send(JSON.stringify({ type: 'error', message: 'Não foi possível processar a mensagem' })); } catch { /* socket closed */ }
    }
  }

  private async controlClosed(socket: WebSocket) {
    const sdrId = this.sessions.get(socket);
    if (!sdrId) return;
    const isCurrentSocket = this.controls.get(sdrId) === socket;
    if (isCurrentSocket) this.controls.delete(sdrId);
    this.sessions.delete(socket);
    const tenantId = this.tenantBySdr.get(sdrId) ?? legacyTenantId();
    if (!isCurrentSocket) return;
    this.tenantBySdr.delete(sdrId);
    await this.db.query(`UPDATE sdrs SET available = false, state = CASE WHEN current_pause_id IS NULL THEN 'offline' ELSE state END WHERE tenant_id = $1 AND id = $2`, [tenantId, sdrId]);
    await this.dialer.handleSdrDisconnected(sdrId, tenantId);
  }

  private handleMedia(socket: WebSocket, sdrId: string, callId: string, identity: { tenantId: string }) {
    socket.on('error', () => socket.close());
    void this.dialer.attachMedia(callId, sdrId, socket, identity.tenantId);
  }
}
