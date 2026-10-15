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
import { DialRefusedError } from '../dialer/dial-intents';

type StationIdentity = { userId: string; tenantId: string; name: string; platformRole: string; integrationId?: string | null };

@Injectable()
export class SdrGateway implements OnModuleDestroy {
  private readonly logger = new Logger(SdrGateway.name);
  private readonly controls = new Map<string, WebSocket>();
  private readonly sessions = new Map<WebSocket, string>();
  private readonly tenantBySdr = new Map<string, string>();
  private readonly operations = new Map<WebSocket, { tenantId: string; userId: string }>();
  // Stations opened through a CRM integration ticket: manual calls only, never the automatic queue.
  private readonly manualOnly = new Set<string>();
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
          if (identity.integrationId && !(await this.integrationAllowsOrigin(identity.integrationId, request.headers.origin))) { socket.destroy(); return; }
          const access = this.entitlement ? await this.entitlement.getAccess(identity.tenantId) : null;
          // A tenant without an active plan can't open a station -- except a platform admin with edit
          // mode on, the same rule every other admin write on a read-only tenant follows.
          const adminOverride = identity.platformRole === 'super_admin' && access?.mode === 'read_only' && this.entitlement ? await this.entitlement.hasAdminWriteMode(identity.userId) : false;
          if (route.kind === 'control' && this.entitlement?.enforcementMode === 'enforce' && access?.mode !== 'full' && !adminOverride) { socket.destroy(); return; }
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
    this.manualOnly.clear();
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

  // A ticket issued to an integration only opens a station from the CRM's own origins (when it
  // declared any) and only while the integration is active.
  private async integrationAllowsOrigin(integrationId: string, origin: unknown) {
    const result = await this.db.query(`SELECT status, allowed_origins FROM crm_integrations WHERE id = $1 LIMIT 1`, [integrationId]);
    const integration = result.rows[0];
    if (!integration || integration.status !== 'active') return false;
    const allowed: string[] = Array.isArray(integration.allowed_origins) ? integration.allowed_origins : [];
    if (!allowed.length) return true;
    const normalized = String(origin ?? '').trim().replace(/\/+$/, '').toLowerCase();
    return allowed.some((item) => item.trim().replace(/\/+$/, '').toLowerCase() === normalized);
  }

  private handleControl(socket: WebSocket, identity: StationIdentity) {
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

  private async handleControlMessage(socket: WebSocket, raw: string, identity: StationIdentity) {
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
          if (membership.rows[0]?.role !== 'sdr' && membership.rows[0]?.role !== 'leader') throw new Error('Seu acesso não permite abrir a estação de ligação');
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
        const stationMode = identity.integrationId ? 'manual_only' : 'standard';
        const claimed = await this.db.query(`
          UPDATE sdrs SET user_id = $1, session_id = $2, connection_instance_id = $5, station_mode = $6,
            available = CASE WHEN $6::text = 'manual_only' THEN false ELSE available END,
            state = CASE WHEN $6::text = 'manual_only' AND state = 'available' THEN 'offline' ELSE state END
          WHERE tenant_id = $3 AND id = $4
          RETURNING id, name, available, state, current_pause_id, station_mode
        `, [identity.userId, String(message.sessionId ?? ''), identity.tenantId, sdr.id, runtimeInstanceId, stationMode]);
        const sdrId = claimed.rows[0].id;
        const tenantId = identity.tenantId;
        const previousSocket = this.controls.get(sdrId);
        this.controls.set(sdrId, socket); this.sessions.set(socket, sdrId); this.tenantBySdr.set(sdrId, tenantId);
        if (identity.integrationId) this.manualOnly.add(sdrId); else this.manualOnly.delete(sdrId);
        if (previousSocket && previousSocket !== socket) {
          try { previousSocket.close(4000, 'nova sessao SDR conectada'); } catch { /* socket already closed */ }
        }
        const state = await this.dialer.getSdrState(sdrId, tenantId);
        socket.send(JSON.stringify({ type: 'identified', sdr: { ...claimed.rows[0], ...state } }));
      } else if (message.type === 'availability') {
        const sdrId = this.sessions.get(socket);
        if (sdrId && this.manualOnly.has(sdrId) && message.available) {
          socket.send(JSON.stringify({ type: 'error', code: 'manual_only_station', message: 'Esta estação faz apenas ligações manuais' }));
        } else if (sdrId) {
          const state = await this.dialer.setAvailability(sdrId, Boolean(message.available), this.tenantBySdr.get(sdrId) ?? legacyTenantId());
          socket.send(JSON.stringify({ type: 'availability_changed', available: Boolean(message.available), sdr: state }));
        }
      } else if (message.type === 'hangup') {
        const sdrId = this.sessions.get(socket);
        if (!sdrId) throw new Error('Socket ainda não identificado');
        await this.dialer.recordOutcome(String(message.callId), 'sdr_hangup', this.tenantBySdr.get(sdrId) ?? legacyTenantId(), sdrId);
      } else if (message.type === 'dial') {
        const sdrId = this.sessions.get(socket);
        if (!sdrId) throw new Error('Socket ainda não identificado');
        await this.handleDial(socket, sdrId, String(message.intentId ?? ''), identity);
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

  // `dial` redeems an intent the CRM obtained server-side. Its refusals carry a code the CRM can
  // act on, so they are reported as `dial_failed` instead of the generic socket error.
  private async handleDial(socket: WebSocket, sdrId: string, intentId: string, identity: StationIdentity) {
    const tenantId = this.tenantBySdr.get(sdrId) ?? identity.tenantId;
    const reply = (payload: Record<string, unknown>) => { try { socket.send(JSON.stringify({ intentId, ...payload })); } catch { /* socket closed */ } };
    if (!identity.integrationId) return reply({ type: 'dial_failed', code: 'not_integration_station', message: 'Disponível apenas para estações integradas' });
    try {
      const result = await this.dialer.dialFromIntent(intentId, sdrId, tenantId);
      reply({ type: 'dial_accepted', callId: result.callId, leadId: result.leadId });
    } catch (error) {
      if (error instanceof DialRefusedError) return reply({ type: 'dial_failed', code: error.code, message: error.message, retryAfterSeconds: error.retryAfterSeconds });
      const response = (error as { getResponse?: () => any }).getResponse?.();
      if (response) return reply({ type: 'dial_failed', code: response.code ?? 'refused', message: response.message ?? (error as Error).message });
      // Plain dialer errors are operator-facing Portuguese messages without personal data.
      reply({ type: 'dial_failed', code: 'refused', message: String((error as Error).message ?? error).slice(0, 300) });
    }
  }

  private async controlClosed(socket: WebSocket) {
    const sdrId = this.sessions.get(socket);
    if (!sdrId) return;
    const isCurrentSocket = this.controls.get(sdrId) === socket;
    if (isCurrentSocket) { this.controls.delete(sdrId); this.manualOnly.delete(sdrId); }
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
