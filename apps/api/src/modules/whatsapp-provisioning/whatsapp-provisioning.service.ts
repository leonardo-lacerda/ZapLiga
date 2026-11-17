import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { GeelarkWorkerClient, GeelarkWorkerError, WorkerJob, WorkerJobStatus } from '../../infrastructure/geelark-worker/geelark-worker.client';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { WaxumClient } from '../../infrastructure/waxum/waxum.client';
import { normalizeWaxumStatus } from '../../infrastructure/waxum/waxum-status';
import { AuditService } from '../audit/audit.service';
import { EntitlementService } from '../billing/entitlement.service';
import { EgressService } from '../egress/egress.service';
import { NumbersService } from '../numbers/numbers.service';
import { egressSocksConfig, socksProxiesFor } from './egress-socks';

export const MAX_PROFILE_PHOTO_BYTES = 2 * 1024 * 1024;

const JOB_STATUSES = new Set<WorkerJobStatus>(['running', 'waiting_input', 'done', 'failed', 'cancelled']);
const FINISHED_STATUSES = new Set<string>(['done', 'failed', 'cancelled']);
const AWAITING_VALUES = new Set(['sms', 'profile', 'link_decision', 'pair_code']);
// `node` is the id of an attendant PC (egress_pcs.id).
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

export type ProvisioningJobRow = {
  id: string; tenant_id: string; created_by: string | null; egress_node: string; geelark_phone_id: string; phone_name: string | null;
  app: 'whatsapp' | 'business'; phone: string; status: string; step: string; awaiting: string | null; message: string | null;
  error_code: string | null; egress_ip: string | null; has_screenshot: boolean; history: unknown; linked: boolean; number_id: string | null;
  link_started_at: Date | string | null; created_at: Date | string; updated_at: Date | string; finished_at: Date | string | null;
  power_off_when_done?: boolean | null;
};

/** `node` = PC id; `publicIps` stays empty: the worker finds the PC's IP through the proxy (contract section 4). */
export type EgressNode = { node: string; label: string; pcName: string; online: boolean; publicIps: string[]; userId: string | null; userName: string | null; isMine: boolean };
type EgressPc = { id: string; name: string; slot: string; online: boolean };
type FinishOutcome = { status: 'failed' | 'cancelled' | 'done'; errorCode: string | null; message: string; linked?: boolean };
const LINKED_MESSAGE = 'Número cadastrado e conectado ao ZapLiga.';
type Assignment = { user_id: string | null; user_name: string | null };
type UploadedPhoto = { buffer: Buffer; size: number; mimetype?: string };

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : (value == null ? null : String(value)));

/** Keeps digits only after dropping the usual separators; anything else makes it invalid. */
const cleanDigits = (value: unknown) => {
  const stripped = String(value ?? '').replace(/[\s().+-]/g, '');
  return /^\d+$/.test(stripped) ? stripped : '';
};

const sniffImageMime = (buffer: Buffer): 'image/jpeg' | 'image/png' | null => {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
};

const errorMessage = (error: unknown) => {
  if (error instanceof HttpException) {
    const response = error.getResponse() as string | { message?: unknown };
    const message = typeof response === 'string' ? response : response?.message;
    return String(Array.isArray(message) ? message.join('; ') : (message ?? error.message)).slice(0, 200);
  }
  return 'erro inesperado';
};

const sanitizeHistory = (value: unknown) => (Array.isArray(value) ? value : []).slice(-100).map((entry: any) => ({
  step: String(entry?.step ?? '').slice(0, 60),
  at: String(entry?.at ?? ''),
  message: entry?.message == null ? null : String(entry.message).slice(0, 500),
}));

/**
 * Internal operation flow that registers a WhatsApp number on a GeeLark cloud
 * phone (docs/provisioning-contract.md, section 3). The geelark-worker owns the
 * phone automation; this service owns the tenant copy of each job, the egress
 * choice (an attendant's PC, reached through the SOCKS gateway) and the optional
 * link to ZapLiga by pairing code.
 *
 * The SMS code and the pairing code only pass through memory: they are never
 * written to the database, logs or audit metadata.
 */
@Injectable()
export class WhatsappProvisioningService {
  private readonly logger = new Logger(WhatsappProvisioningService.name);
  /** Overridable in tests. */
  timing = { pollIntervalMs: 2_000, pairCodeWaitMs: 90_000, linkTimeoutMs: 120_000 };

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly entitlement: EntitlementService,
    private readonly redis: RedisService,
    private readonly worker: GeelarkWorkerClient,
    private readonly egress: EgressService,
    private readonly numbers: NumbersService,
    private readonly waxum: WaxumClient,
  ) {}

  // ---------------------------------------------------------------- egress

  /** Tailscale connected (Admin → Saídas de internet) and the SOCKS gateway's public host + password set. */
  private async egressConfigured() {
    if (!egressSocksConfig()) return false;
    return (await this.egress.settings()).configured;
  }

  async listEgress(tenantId: string, userId: string) {
    if (!(await this.egressConfigured())) return { items: [] as EgressNode[], configured: false };
    const [pcs, assignments] = await Promise.all([this.egress.pcExits(), this.assignments(tenantId)]);
    const items = pcs.map((pc) => this.toEgressNode(pc, assignments.get(pc.id), userId));
    items.sort((a, b) => Number(b.isMine) - Number(a.isMine) || Number(b.online) - Number(a.online) || a.label.localeCompare(b.label));
    return { items, configured: true };
  }

  async assignEgress(tenantId: string, actorUserId: string, rawNode: string, userId: string | null) {
    await this.entitlement.assertAction(tenantId, 'write', actorUserId);
    const node = String(rawNode ?? '').trim();
    if (!NODE_ID.test(node)) throw new BadRequestException('PC inválido');
    const [pc] = await this.egress.pcExits(node);
    if (!pc) throw new NotFoundException('PC não encontrado em Admin → Saídas de internet');
    let assignment: Assignment = { user_id: null, user_name: null };
    if (userId) {
      // A person of this tenant, or a platform super admin (the operation's admins act on tenants without a membership).
      const user = (await this.db.query(`SELECT u.id, u.name FROM users u
        WHERE u.id = $2 AND u.status = 'active'
          AND (u.platform_role = 'super_admin' OR EXISTS (SELECT 1 FROM tenant_memberships tm WHERE tm.tenant_id = $1 AND tm.user_id = u.id AND tm.status = 'active'))
        LIMIT 1`, [tenantId, userId])).rows[0];
      if (!user) throw new BadRequestException('Essa pessoa não faz parte desta empresa');
      await this.db.query(`INSERT INTO provisioning_egress_nodes (tenant_id, node_name, user_id, updated_at) VALUES ($1, $2, $3, now())
        ON CONFLICT (tenant_id, node_name) DO UPDATE SET user_id = EXCLUDED.user_id, updated_at = now()`, [tenantId, pc.id, user.id]);
      assignment = { user_id: user.id, user_name: user.name };
    } else {
      await this.db.query('DELETE FROM provisioning_egress_nodes WHERE tenant_id = $1 AND node_name = $2', [tenantId, pc.id]);
    }
    await this.audit.record({ actorUserId, tenantId, action: 'provisioning.egress_assigned', entityType: 'provisioning_egress_node', entityId: pc.id, metadata: { userId: assignment.user_id } });
    return this.toEgressNode(pc, assignment, actorUserId);
  }

  private async assignments(tenantId: string) {
    const result = await this.db.query(`SELECT n.node_name, n.user_id, u.name AS user_name FROM provisioning_egress_nodes n
      LEFT JOIN users u ON u.id = n.user_id WHERE n.tenant_id = $1`, [tenantId]);
    return new Map<string, Assignment>(result.rows.map((row: any) => [String(row.node_name), { user_id: row.user_id ?? null, user_name: row.user_name ?? null }]));
  }

  private toEgressNode(pc: EgressPc, assignment: Assignment | undefined, userId: string): EgressNode {
    const assignedUserId = assignment?.user_id ?? null;
    const userName = assignment?.user_name ?? null;
    return { node: pc.id, label: userName || pc.name, pcName: pc.name, online: pc.online, publicIps: [], userId: assignedUserId, userName, isMine: Boolean(assignedUserId && assignedUserId === userId) };
  }

  private egressNotConfigured() {
    return new HttpException({ statusCode: HttpStatus.SERVICE_UNAVAILABLE, code: 'egress_not_configured', message: 'A saída pelos PCs dos atendentes ou o proxy do cadastro não estão configurados no servidor.' }, HttpStatus.SERVICE_UNAVAILABLE);
  }

  // ---------------------------------------------------------------- phones

  async listPhones() { return { items: await this.worker.listPhones() }; }

  // ---------------------------------------------------------------- jobs

  async createJob(tenantId: string, actorUserId: string, input: { egressNode: string; geelarkPhoneId: string; app: 'whatsapp' | 'business'; countryCode: string; number: string; powerOffWhenDone?: boolean }) {
    await this.entitlement.assertAction(tenantId, 'write', actorUserId);
    const countryCode = cleanDigits(input.countryCode);
    const number = cleanDigits(input.number);
    if (!/^[1-9]\d{0,2}$/.test(countryCode) || !/^\d{6,13}$/.test(number) || countryCode.length + number.length > 15) {
      throw new BadRequestException({ statusCode: 400, code: 'invalid_number', message: 'Informe o código do país (ex.: 55) e o número com DDD, só com dígitos.' });
    }
    if (input.app !== 'whatsapp' && input.app !== 'business') throw new BadRequestException('App inválido');
    const socks = egressSocksConfig();
    if (!socks || !(await this.egressConfigured())) throw this.egressNotConfigured();
    const node = String(input.egressNode ?? '').trim();
    // The PC's slot is resolved now (it may change later) and must be going out through the PC right now.
    const pc = NODE_ID.test(node) ? (await this.egress.pcExits(node))[0] : undefined;
    if (!pc?.online) {
      throw new ConflictException({ statusCode: 409, code: 'egress_offline', message: 'O PC escolhido não está online agora. Ligue-o ou escolha outro.' });
    }
    const { proxy, probeProxy } = socksProxiesFor(socks, pc.slot);
    const phone = (await this.worker.listPhones()).find((item) => item.id === input.geelarkPhoneId);
    if (!phone) throw new NotFoundException({ statusCode: 404, code: 'phone_not_found', message: 'Telefone não encontrado no GeeLark.' });
    if (phone.status === 'expired') throw new ConflictException({ statusCode: 409, code: 'phone_expired', message: 'Este telefone do GeeLark expirou.' });

    const id = randomUUID();
    const fullNumber = `${countryCode}${number}`;
    const inserted = (await this.db.query(`INSERT INTO provisioning_jobs (id, tenant_id, created_by, egress_node, geelark_phone_id, phone_name, app, phone, status, step, power_off_when_done)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running', 'queued', $9) RETURNING *`, [id, tenantId, actorUserId, pc.id, phone.id, phone.name || null, input.app, fullNumber, input.powerOffWhenDone !== false])).rows[0] as ProvisioningJobRow;
    let snapshot: WorkerJob;
    try {
      snapshot = await this.worker.createJob({
        jobId: id, phoneId: phone.id, app: input.app, countryCode, number, proxy, probeProxy,
        // Empty: the worker probes the PC's IP through probeProxy and expects the phone to see the same.
        expectedEgressIps: [], powerOffWhenDone: input.powerOffWhenDone !== false,
      });
    } catch (error) {
      // Nothing started: drop the copy. On a timeout the worker may have accepted it, so ask it to stop.
      if (error instanceof GeelarkWorkerError && error.workerCode === 'worker_timeout') await this.worker.cancelJob(id).catch(() => undefined);
      await this.db.query('DELETE FROM provisioning_jobs WHERE id = $1 AND tenant_id = $2', [id, tenantId]).catch(() => undefined);
      throw error;
    }
    await this.audit.record({ actorUserId, tenantId, action: 'provisioning.started', entityType: 'provisioning_job', entityId: id, metadata: { app: input.app, egressNode: pc.id, slot: pc.slot, geelarkPhoneId: phone.id } });
    return this.toJob(await this.applySnapshot(inserted, snapshot, actorUserId));
  }

  async listJobs(tenantId: string, limit?: number) {
    const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)));
    const result = await this.db.query('SELECT * FROM provisioning_jobs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2', [tenantId, safeLimit]);
    return { items: result.rows.map((row: ProvisioningJobRow) => this.toJob(row)) };
  }

  /** Syncs the job from the worker (or Waxum while linking), persists the snapshot and returns it. */
  async getJob(tenantId: string, actorUserId: string, id: string) {
    return this.toJob(await this.sync(await this.findRow(tenantId, id), actorUserId));
  }

  async submitSms(tenantId: string, actorUserId: string, id: string, rawCode: string) {
    await this.entitlement.assertAction(tenantId, 'write', actorUserId);
    const row = this.assertOpen(await this.findRow(tenantId, id));
    const code = String(rawCode ?? '').replace(/\D/g, '');
    if (!/^\d{6}$/.test(code)) throw new BadRequestException('O código SMS deve ter 6 dígitos');
    const next = await this.withWorker(row, actorUserId, () => this.worker.sendInput(row.id, { type: 'sms', code }));
    // No code in the audit trail: only the fact that one was sent.
    await this.audit.record({ actorUserId, tenantId, action: 'provisioning.sms_submitted', entityType: 'provisioning_job', entityId: row.id });
    return this.toJob(next);
  }

  async submitProfile(tenantId: string, actorUserId: string, id: string, rawName: string, photo?: UploadedPhoto) {
    await this.entitlement.assertAction(tenantId, 'write', actorUserId);
    const row = this.assertOpen(await this.findRow(tenantId, id));
    const name = String(rawName ?? '').trim();
    if (!name || name.length > 25) throw new BadRequestException('O nome do perfil deve ter de 1 a 25 caracteres');
    let photoFields: { photoBase64?: string; photoMime?: 'image/jpeg' | 'image/png' } = {};
    if (photo?.buffer?.length) {
      if (photo.size > MAX_PROFILE_PHOTO_BYTES || photo.buffer.length > MAX_PROFILE_PHOTO_BYTES) throw new BadRequestException('A foto deve ter no máximo 2 MB');
      const mime = sniffImageMime(photo.buffer);
      if (!mime) throw new BadRequestException('A foto deve ser JPEG ou PNG');
      photoFields = { photoBase64: photo.buffer.toString('base64'), photoMime: mime };
    }
    const next = await this.withWorker(row, actorUserId, () => this.worker.sendInput(row.id, { type: 'profile', name, ...photoFields }));
    return this.toJob(next);
  }

  async decideLink(tenantId: string, actorUserId: string, id: string, connect: boolean) {
    await this.entitlement.assertAction(tenantId, 'write', actorUserId);
    const row = this.assertOpen(await this.findRow(tenantId, id));
    if (!connect) return this.toJob(await this.withWorker(row, actorUserId, () => this.worker.sendInput(row.id, { type: 'finish' })));
    const lockKey = `zapcall:provisioning:${row.id}:link`;
    const token = randomUUID();
    const locked = await this.redis.acquireLock(lockKey, token, this.timing.pairCodeWaitMs + 90_000).catch(() => false);
    if (!locked) throw new ConflictException('A conexão deste número ao ZapLiga já está em andamento.');
    try {
      return this.toJob(await this.runLink(row, actorUserId));
    } finally {
      await this.redis.releaseLock(lockKey, token).catch(() => undefined);
    }
  }

  async cancel(tenantId: string, actorUserId: string, id: string) {
    await this.entitlement.assertAction(tenantId, 'write', actorUserId);
    const row = await this.findRow(tenantId, id);
    if (row.finished_at || FINISHED_STATUSES.has(row.status)) return this.toJob(row);
    if (row.step !== 'linking') {
      let snapshot: WorkerJob | null = null;
      try { snapshot = await this.worker.cancelJob(row.id); }
      catch (error) {
        if (!(error instanceof GeelarkWorkerError && error.getStatus() === HttpStatus.NOT_FOUND)) throw error;
        // The worker no longer knows the job: make sure the phone is not left on.
        await this.stopPhone(row);
      }
      if (snapshot) {
        const next = await this.applySnapshot(row, snapshot, actorUserId);
        if (next.finished_at) return this.toJob(next);
      }
    }
    // While linking the worker is already done (and left the phone on); the line stays in Números.
    else await this.powerOffAfterLink(row);
    const next = await this.finish(row, { status: 'cancelled', errorCode: 'cancelled', message: 'Cadastro cancelado.' });
    await this.auditTransitions(row, next, actorUserId);
    return this.toJob(next);
  }

  async screenshot(tenantId: string, id: string) {
    const row = await this.findRow(tenantId, id);
    const png = await this.worker.screenshot(row.id);
    if (!png) throw new NotFoundException('Não há captura de tela deste cadastro.');
    return png;
  }

  // ---------------------------------------------------------------- internals

  private async findRow(tenantId: string, id: string) {
    const row = (await this.db.query('SELECT * FROM provisioning_jobs WHERE id = $1 AND tenant_id = $2', [String(id ?? ''), tenantId])).rows[0] as ProvisioningJobRow | undefined;
    if (!row) throw new NotFoundException('Cadastro não encontrado');
    return row;
  }

  private assertOpen(row: ProvisioningJobRow) {
    if (row.finished_at || FINISHED_STATUSES.has(row.status)) throw new ConflictException('Este cadastro já terminou.');
    if (row.step === 'linking') throw new ConflictException('O número já está sendo conectado ao ZapLiga.');
    return row;
  }

  private async sync(row: ProvisioningJobRow, actorUserId: string | null): Promise<ProvisioningJobRow> {
    if (row.finished_at) return row;
    if (row.step === 'linking') return this.checkLink(row, actorUserId);
    const snapshot = await this.worker.getJob(row.id);
    if (!snapshot) return this.markWorkerLost(row, actorUserId);
    return this.applySnapshot(row, snapshot, actorUserId);
  }

  /** Runs a worker call that returns the job; a worker 404 means it lost the job. */
  private async withWorker(row: ProvisioningJobRow, actorUserId: string, call: () => Promise<WorkerJob>) {
    let snapshot: WorkerJob;
    try { snapshot = await call(); }
    catch (error) {
      if (error instanceof GeelarkWorkerError && error.getStatus() === HttpStatus.NOT_FOUND) return this.markWorkerLost(row, actorUserId);
      throw error;
    }
    return this.applySnapshot(row, snapshot, actorUserId);
  }

  /**
   * Persists the worker's view of the job. When the worker finishes (`done`)
   * after receiving a pairing code, the API takes over in step `linking` until
   * the Waxum session reports `connected` (or the 120 s timeout).
   */
  private async applySnapshot(row: ProvisioningJobRow, snapshot: WorkerJob, actorUserId: string | null): Promise<ProvisioningJobRow> {
    const workerStatus = JOB_STATUSES.has(snapshot?.status) ? snapshot.status : 'running';
    const linking = workerStatus === 'done' && Boolean(row.number_id) && !row.linked;
    const status = linking ? 'running' : workerStatus;
    const step = linking ? 'linking' : String(snapshot?.step || row.step || 'queued').slice(0, 60);
    const awaiting = linking || !AWAITING_VALUES.has(String(snapshot?.awaiting)) ? null : snapshot.awaiting;
    const message = linking ? 'Aguardando o WhatsApp confirmar a conexão com o ZapLiga.' : (snapshot?.message == null ? null : String(snapshot.message).slice(0, 1000));
    const finished = FINISHED_STATUSES.has(status);
    const result = await this.db.query(`UPDATE provisioning_jobs SET status = $3, step = $4, awaiting = $5, message = $6, error_code = $7, egress_ip = $8,
        has_screenshot = $9, history = $10::jsonb,
        link_started_at = CASE WHEN $11::boolean THEN COALESCE(link_started_at, now()) ELSE link_started_at END,
        finished_at = CASE WHEN $12::boolean THEN now() ELSE NULL END, updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND finished_at IS NULL RETURNING *`, [
      row.id, row.tenant_id, status, step, awaiting, message,
      snapshot?.errorCode ? String(snapshot.errorCode).slice(0, 60) : null,
      snapshot?.egressIp ? String(snapshot.egressIp).slice(0, 64) : null,
      Boolean(snapshot?.hasScreenshot), JSON.stringify(sanitizeHistory(snapshot?.history)), linking, finished,
    ]);
    const next = (result.rows[0] as ProvisioningJobRow | undefined) ?? await this.findRow(row.tenant_id, row.id);
    await this.auditTransitions(row, next, actorUserId);
    if (linking && next.step === 'linking' && !next.finished_at) return this.checkLink(next, actorUserId);
    return next;
  }

  private async auditTransitions(previous: ProvisioningJobRow, next: ProvisioningJobRow, actorUserId: string | null) {
    const registered = (job: ProvisioningJobRow) => job.step === 'registered' || job.awaiting === 'link_decision';
    if (registered(next) && !registered(previous)) await this.auditOnce(next, 'provisioning.registered', actorUserId, { app: next.app });
    if (next.status === 'failed' && previous.status !== 'failed') await this.auditOnce(next, 'provisioning.failed', actorUserId, { errorCode: next.error_code, step: next.step });
    if (next.status === 'cancelled' && previous.status !== 'cancelled') await this.auditOnce(next, 'provisioning.cancelled', actorUserId, { step: next.step });
  }

  /** api-a and api-b both answer the panel's polling: a one-shot event is recorded once. */
  private async auditOnce(row: ProvisioningJobRow, action: string, actorUserId: string | null, metadata: Record<string, unknown> = {}) {
    const first = await this.redis.client.set(`zapcall:provisioning:${row.id}:audit:${action}`, '1', 'EX', 7 * 86_400, 'NX').catch(() => 'OK');
    if (first !== 'OK') return;
    await this.audit.record({ actorUserId, tenantId: row.tenant_id, action, entityType: 'provisioning_job', entityId: row.id, metadata });
  }

  private async finish(row: ProvisioningJobRow, outcome: FinishOutcome) {
    return (await this.tryFinish(row, outcome)) ?? this.findRow(row.tenant_id, row.id);
  }

  /** `undefined` when the job had already finished (e.g. settled by the other API instance). */
  private async tryFinish(row: ProvisioningJobRow, outcome: FinishOutcome) {
    const result = await this.db.query(`UPDATE provisioning_jobs SET status = $3, awaiting = NULL, error_code = $4, message = $5,
        step = CASE WHEN $3 = 'done' THEN 'done' ELSE step END, linked = linked OR $6::boolean, finished_at = now(), updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND finished_at IS NULL RETURNING *`, [row.id, row.tenant_id, outcome.status, outcome.errorCode, outcome.message, Boolean(outcome.linked)]);
    return result.rows[0] as ProvisioningJobRow | undefined;
  }

  private async markWorkerLost(row: ProvisioningJobRow, actorUserId: string | null) {
    const next = await this.finish(row, { status: 'failed', errorCode: 'worker_lost', message: 'O cadastrador reiniciou e perdeu este cadastro. O telefone foi desligado; comece um novo cadastro.' });
    await this.stopPhone(row);
    await this.auditTransitions(row, next, actorUserId);
    return next;
  }

  private async stopPhone(row: ProvisioningJobRow) {
    await this.worker.stopPhone(row.geelark_phone_id).catch((error) => this.logger.warn(`Could not stop GeeLark phone of job ${row.id}: ${errorMessage(error)}`));
  }

  private async failLink(row: ProvisioningJobRow, actorUserId: string, message: string) {
    // Cancelling the worker job also powers the phone off.
    await this.worker.cancelJob(row.id).catch((error) => this.logger.warn(`Could not cancel worker job ${row.id}: ${errorMessage(error)}`));
    const next = await this.finish(row, { status: 'failed', errorCode: 'pair_failed', message });
    await this.auditTransitions(row, next, actorUserId);
    return next;
  }

  /**
   * `connect=true`: the phone opens "Link with phone number", then (and only
   * then, since Waxum's code lives 60 s) the line is created and the code is
   * requested and handed to the worker. The following GETs follow the Waxum
   * session in step `linking`.
   */
  private async runLink(row: ProvisioningJobRow, actorUserId: string): Promise<ProvisioningJobRow> {
    let current = row;
    if (current.awaiting !== 'pair_code') {
      current = await this.withWorker(current, actorUserId, () => this.worker.sendInput(row.id, { type: 'link' }));
    }
    const deadline = Date.now() + this.timing.pairCodeWaitMs;
    while (current.awaiting !== 'pair_code') {
      if (current.finished_at) return current;
      if (Date.now() >= deadline) return this.failLink(current, actorUserId, 'O telefone não chegou à tela "Conectar com número de telefone" a tempo.');
      await new Promise((resolve) => setTimeout(resolve, this.timing.pollIntervalMs));
      const snapshot = await this.worker.getJob(current.id);
      if (!snapshot) return this.markWorkerLost(current, actorUserId);
      current = await this.applySnapshot(current, snapshot, actorUserId);
    }

    let sessionId: string;
    try {
      if (current.number_id) {
        const existing = (await this.db.query('SELECT id, waxum_session_id FROM whatsapp_numbers WHERE id = $1 AND tenant_id = $2', [current.number_id, current.tenant_id])).rows[0];
        if (!existing) throw new NotFoundException('A linha criada para este cadastro não existe mais');
        sessionId = existing.waxum_session_id;
      } else {
        const line = await this.numbers.create(current.tenant_id, actorUserId, { label: current.phone_name?.trim() || current.phone, phone: current.phone });
        sessionId = line.waxum_session_id;
        const updated = (await this.db.query('UPDATE provisioning_jobs SET number_id = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *', [current.id, current.tenant_id, line.id])).rows[0] as ProvisioningJobRow | undefined;
        current = updated ?? { ...current, number_id: line.id };
      }
    } catch (error) {
      return this.failLink(current, actorUserId, `Não foi possível criar a linha no ZapLiga: ${errorMessage(error)}`);
    }

    // Only in memory: the code goes from Waxum to the worker, never to the database, logs or audit.
    let code: string;
    try {
      code = (await this.requestPairCode(current, actorUserId, sessionId)).code;
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      return this.failLink(current, actorUserId, error instanceof HttpException
        ? `O Waxum recusou o pareamento: ${errorMessage(error)}. A linha ficou em Números para conectar pelo QR Code.`
        : `O Waxum não gerou o código de pareamento (${status ?? 'sem resposta'}). A linha ficou em Números para conectar pelo QR Code.`);
    }

    try {
      return await this.withWorker(current, actorUserId, () => this.worker.sendInput(current.id, { type: 'pair_code', code }));
    } catch (error) {
      return this.failLink(current, actorUserId, `O código de pareamento não chegou ao telefone: ${errorMessage(error)}`);
    }
  }

  /**
   * The same pairing the Números page uses (NumbersService.pairCode audits
   * `number.pair_code_requested` and replaces a session Waxum lost). A brand-new
   * session may need /connect before Waxum accepts pairing (same as the QR flow).
   */
  private async requestPairCode(job: ProvisioningJobRow, actorUserId: string, sessionId: string) {
    const numberId = String(job.number_id);
    try {
      return await this.numbers.pairCode(job.tenant_id, actorUserId, numberId, job.phone);
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 503) throw error;
      const line = (await this.db.query('SELECT id, waxum_session_id FROM whatsapp_numbers WHERE id = $1 AND tenant_id = $2', [numberId, job.tenant_id])).rows[0];
      await this.waxum.reconnect(line?.waxum_session_id ?? sessionId);
      return this.numbers.pairCode(job.tenant_id, actorUserId, numberId, job.phone);
    }
  }

  /** Step `linking`: the worker is done; wait for the Waxum session to report connected. */
  private async checkLink(row: ProvisioningJobRow, actorUserId: string | null): Promise<ProvisioningJobRow> {
    const line = row.number_id
      ? (await this.db.query('SELECT id, waxum_session_id FROM whatsapp_numbers WHERE id = $1 AND tenant_id = $2', [row.number_id, row.tenant_id])).rows[0]
      : null;
    if (line?.waxum_session_id) {
      try {
        const status = normalizeWaxumStatus(await this.waxum.getStatus(line.waxum_session_id));
        if (status.connected) {
          await this.db.query("UPDATE whatsapp_numbers SET status = 'connected', phone = COALESCE($3, phone) WHERE id = $1 AND tenant_id = $2", [line.id, row.tenant_id, status.phone]);
          // api-a and api-b both poll: only the one that settles the job moves the line and powers the phone off.
          const next = await this.tryFinish(row, { status: 'done', errorCode: null, message: LINKED_MESSAGE, linked: true });
          if (!next) return this.findRow(row.tenant_id, row.id);
          await this.auditOnce(next, 'provisioning.linked', actorUserId, { numberId: line.id });
          const message = await this.moveLineToJobPc(next, line.id, actorUserId);
          await this.powerOffAfterLink(row);
          const updated = await this.db.query('UPDATE provisioning_jobs SET message = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *', [row.id, row.tenant_id, message]);
          return (updated.rows[0] as ProvisioningJobRow | undefined) ?? { ...next, message };
        }
      } catch (error) {
        this.logger.warn(`Waxum status unavailable while linking job ${row.id}: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
      }
    }
    const startedAt = row.link_started_at ? new Date(row.link_started_at).getTime() : Date.now();
    if (Date.now() - startedAt < this.timing.linkTimeoutMs) return row;
    const next = await this.finish(row, { status: 'failed', errorCode: 'link_timeout', message: 'O WhatsApp não confirmou a conexão em 2 minutos. A linha já está em Números: conecte-a pelo QR Code.' });
    await this.auditTransitions(row, next, actorUserId);
    await this.powerOffAfterLink(row);
    return next;
  }

  /**
   * The line goes out through the same PC the phone used to register, so WhatsApp
   * keeps seeing one IP for the number (contract section 3). Best effort: with the
   * PC offline, without a slot or on any error the line stays on the VPS, the job
   * stays `done` and the returned message says so.
   */
  private async moveLineToJobPc(job: ProvisioningJobRow, numberId: string, actorUserId: string | null) {
    let pcName = 'usado no cadastro';
    try {
      // The slot is read again: it may have changed since the job started.
      const [pc] = await this.egress.pcExits(job.egress_node);
      if (!pc) return `${LINKED_MESSAGE} Atenção: o PC usado no cadastro não tem mais vaga de saída; a linha ficou saindo pela VPS.`;
      pcName = pc.name;
      if (!pc.online) return `${LINKED_MESSAGE} Atenção: o PC ${pc.name} está offline; a linha ficou saindo pela VPS.`;
      const moved = await this.numbers.moveToWaxumNode(job.tenant_id, actorUserId, numberId, pc.slot);
      return moved?.status === 'connected' || moved?.status == null
        ? `${LINKED_MESSAGE} A linha sai pelo PC ${pc.name}, o mesmo do cadastro.`
        : `${LINKED_MESSAGE} A linha foi levada para o PC ${pc.name} e ainda está reconectando.`;
    } catch (error) {
      this.logger.warn(`Line ${numberId} of job ${job.id} not moved to its PC: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
      return `${LINKED_MESSAGE} Atenção: não foi possível levar a linha para o PC ${pcName} (${errorMessage(error)}); ela ficou saindo pela VPS.`;
    }
  }

  /**
   * The worker leaves the phone on when it ends in `linking`: the primary device
   * must stay online until Waxum confirms the pairing. Once the link settles
   * (connected, timeout or cancel) the API honours `powerOffWhenDone`.
   */
  private async powerOffAfterLink(row: ProvisioningJobRow) {
    if (row.power_off_when_done === false) return;
    await this.stopPhone(row);
  }

  toJob(row: ProvisioningJobRow) {
    return {
      id: row.id,
      jobId: row.id,
      egressNode: row.egress_node,
      geelarkPhoneId: row.geelark_phone_id,
      phoneId: row.geelark_phone_id,
      phoneName: row.phone_name ?? null,
      app: row.app,
      number: row.phone,
      status: row.status,
      step: row.step,
      awaiting: row.awaiting ?? null,
      message: row.message ?? null,
      errorCode: row.error_code ?? null,
      hasScreenshot: Boolean(row.has_screenshot),
      egressIp: row.egress_ip ?? null,
      history: sanitizeHistory(row.history),
      linked: Boolean(row.linked),
      numberId: row.number_id ?? null,
      createdBy: row.created_by,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      finishedAt: iso(row.finished_at),
    };
  }
}
