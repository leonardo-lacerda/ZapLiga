import { Inject, Injectable, Logger, OnModuleDestroy, Optional, forwardRef } from '@nestjs/common';
import { Server } from 'node:http';
import { URL } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { DialerService } from '../dialer/dialer.service';
import { legacyTenantId } from '../../database/tenant-context';
import { AuthService } from '../auth/auth.service';
import { runtimeInstanceId } from '../../infrastructure/runtime-instance';
import { Sentry } from '../../infrastructure/sentry/sentry';
import { parseSdrSocketPath } from './sdr-socket-path';
import { EntitlementService } from '../billing/entitlement.service';

@Injectable()
export class SdrGateway implements OnModuleDestroy {
  private readonly logger = new Logger(SdrGateway.name);
  private readonly controls = new Map<string, WebSocket>();
  private readonly sessions = new Map<WebSocket, string>();
  private readonly tenantBySdr = new Map<string, string>();
  private readonly operations = new Map<WebSocket, { tenantId: string; userId: string }>();
  private server?: WebSocketServer;

  constructor(private readonly db: DatabaseService, private readonly auth: AuthService, @Inject(forwardRef(() => DialerService)) private readonly dialer: DialerService, @Optional() private readonly entitlement?: EntitlementService) {}

  attach(httpServer: Server) {
    // Control/observer messages are small JSON frames and media frames are
    // chunked by the browser. Keep the upgrade endpoint from accepting the
    // ws package's very large default payload while still leaving room for a
    // media frame plus protocol overhead.
    this.server = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    httpServer.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const route = parseSdrSocketPath(url.pathname);
      if (route.kind === 'none') return;
      const ticket = url.searchParams.get('ticket');
      if (!ticket) { socket.destroy(); return; }
      void this.auth.consumeWebsocketTicket(ticket).then((identity) => {
        if (!identity) { socket.destroy(); return; }
        if (route.tenantId && decodeURIComponent(route.tenantId) !== identity.tenantId) { socket.destroy(); return; }
        void (async () => {
          const access = this.entitlement ? await this.entitlement.getAccess(identity.tenantId) : null;
          if (route.kind === 'control' && this.entitlement?.enforcementMode === 'enforce' && access?.mode !== 'full') { socket.destroy(); return; }
          this.server?.handleUpgrade(request, socket, head, (ws) => {
            if (route.kind === 'control') return this.handleControl(ws, identity);
            if (route.kind === 'operations') return void this.handleOperations(ws, identity);
            return this.handleMedia(ws, decodeURIComponent(route.sdrId), decodeURIComponent(route.callId), identity);
          });
        })().catch(() => socket.destroy());
      }).catch(() => socket.destroy());
    });
  }

  onModuleDestroy() { this.closeAll(); this.server?.close(); }
  closeAll() {
    for (const socket of this.controls.values()) socket.close(1001, 'servidor reiniciando');
    for (const socket of this.operations.keys()) socket.close(1001, 'servidor reiniciando');
    this.controls.clear();
    this.sessions.clear();
    this.tenantBySdr.clear();
    this.operations.clear();
  }
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

  broadcastToOperations(message: unknown, tenantId = legacyTenantId()) {
    const payload = JSON.stringify(message);
    for (const [socket, observer] of this.operations.entries()) {
      if (observer.tenantId !== tenantId) continue;
      if (socket.readyState === WebSocket.OPEN) {
        try { socket.send(payload); } catch (error) { this.logger.debug(`Operations broadcast skipped: ${String(error)}`); }
      }
    }
  }

  private handleControl(socket: WebSocket, identity: { userId: string; tenantId: string; name: string; platformRole: string }) {
    socket.on('message', (raw, isBinary) => { if (!isBinary) void this.handleControlMessage(socket, raw.toString(), identity); });
    socket.on('close', () => void this.controlClosed(socket));
    socket.on('error', () => void this.controlClosed(socket));
    try { socket.send(JSON.stringify({ type: 'connected' })); } catch { /* socket closed during handshake */ }
  }

  private async handleOperations(socket: WebSocket, identity: { userId: string; tenantId: string; name: string; platformRole: string }) {
    if (identity.platformRole !== 'super_admin') {
      const membership = await this.db.query(`
        SELECT role FROM tenant_memberships
        WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'
        LIMIT 1
      `, [identity.tenantId, identity.userId]);
      if (membership.rows[0]?.role !== 'leader') {
        socket.close(1008, 'somente lideres podem observar a operacao');
        return;
      }
    }

    this.operations.set(socket, { tenantId: identity.tenantId, userId: identity.userId });
    const cleanup = () => this.operations.delete(socket);
    socket.on('close', cleanup);
    socket.on('error', cleanup);
    try {
      socket.send(JSON.stringify({ type: 'operations_connected' }));
      const snapshot = await this.dialer.getOperationsSnapshot(identity.tenantId);
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'operations_snapshot', snapshot }));
    } catch (error) {
      this.logger.warn(`Falha ao preparar snapshot operacional: ${String(error)}`);
      try { socket.close(1011, 'snapshot indisponivel'); } catch { /* socket closed */ }
      cleanup();
    }
  }

  private async handleControlMessage(socket: WebSocket, raw: string, identity: { userId: string; tenantId: string; name: string; platformRole: string }) {
    let message: any;
    try { message = JSON.parse(raw); } catch { try { socket.send(JSON.stringify({ type: 'error', message: 'JSON inválido' })); } catch {} return; }
    try {
      // Memberships can be revoked while a WebSocket remains open. Re-check
      // before every control action so revocation takes effect immediately,
      // not only after the browser reconnects.
      if (identity.platformRole !== 'super_admin') {
        const membership = await this.db.query(`SELECT 1 FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1`, [identity.tenantId, identity.userId]);
        if (!membership.rows[0]) throw new Error('Acesso da empresa revogado');
      }
      const tenantId = this.tenantBySdr.get(this.sessions.get(socket) ?? '') ?? identity.tenantId;
      if (message.type === 'availability' || message.type === 'identify') await this.entitlement?.assertCanOperate(tenantId, identity.userId);
      if (message.type === 'hangup' || message.type === 'outcome') await this.entitlement?.assertCanFinalize(tenantId);
      if (message.type === 'identify') {
        if (identity.platformRole !== 'super_admin') {
          const membership = await this.db.query(`SELECT role FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1`, [identity.tenantId, identity.userId]);
          if (membership.rows[0]?.role !== 'sdr') throw new Error('Somente usuários SDR podem abrir o canal operacional');
        }
        const name = identity.name.trim();
        const existing = await this.db.query(`
          SELECT id, name, available, state, current_pause_id
          FROM sdrs
          WHERE tenant_id = $1 AND user_id = $2
          LIMIT 1
        `, [identity.tenantId, identity.userId]);
        const sdr = existing.rows[0];
        if (!sdr) throw new Error('Perfil SDR ainda não foi criado');
        const claimed = await this.db.query(`
          UPDATE sdrs SET user_id = $1, session_id = $2, connection_instance_id = $5
          WHERE tenant_id = $3 AND id = $4
          RETURNING id, name, available, state, current_pause_id
        `, [identity.userId, String(message.sessionId ?? ''), identity.tenantId, sdr.id, runtimeInstanceId]);
        const sdrId = claimed.rows[0].id;
        const tenantId = identity.tenantId;
        const previousSocket = this.controls.get(sdrId);
        this.controls.set(sdrId, socket); this.sessions.set(socket, sdrId); this.tenantBySdr.set(sdrId, tenantId);
        if (previousSocket && previousSocket !== socket) {
          try { previousSocket.close(4000, 'nova sessao SDR conectada'); } catch { /* socket already closed */ }
        }
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
      this.logger.warn('Falha ao processar mensagem do canal SDR');
      Sentry.captureException(error);
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
    await this.db.query(`UPDATE sdrs SET available = false, connection_instance_id = NULL, state = CASE WHEN current_pause_id IS NULL THEN 'offline' ELSE state END WHERE tenant_id = $1 AND id = $2 AND connection_instance_id = $3`, [tenantId, sdrId, runtimeInstanceId]);
    await this.dialer.handleSdrDisconnected(sdrId, tenantId);
  }

  private async handleMedia(socket: WebSocket, sdrId: string, callId: string, identity: { tenantId: string; userId: string }) {
    const owner = await this.db.query(`SELECT 1 FROM sdrs s
      JOIN tenant_memberships tm ON tm.tenant_id = s.tenant_id AND tm.user_id = s.user_id AND tm.role = 'sdr' AND tm.status = 'active'
      WHERE s.tenant_id = $1 AND s.id = $2 AND s.user_id = $3 LIMIT 1`, [identity.tenantId, sdrId, identity.userId]);
    if (!owner.rows[0]) return socket.close(1008, 'sdr not owned by ticket');
    socket.on('error', () => socket.close());
    void this.dialer.attachMedia(callId, sdrId, socket, identity.tenantId);
  }
}
