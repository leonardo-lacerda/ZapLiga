import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { RoadmapReasonCode } from '../roadmap-contracts/roadmap-contracts';

export type EligibilityMode = 'automatic' | 'manual' | 'preview' | 'simulation';

export type EligibilityReason = {
  code: RoadmapReasonCode;
  allowed: boolean;
  metadata?: Record<string, unknown>;
};

export type EligibilityResult = {
  eligible: boolean;
  mode: EligibilityMode;
  reasons: EligibilityReason[];
  reasonCodes: RoadmapReasonCode[];
  blockedBy: RoadmapReasonCode[];
  checkedAt: string;
};

export type LeadEligibilityInput = {
  mode: EligibilityMode;
  lead: {
    id?: string;
    phone?: string | null;
    status?: string | null;
    attempts?: number | string | null;
    nextEligibleAt?: Date | string | null;
    doNotCall?: boolean | null;
  };
  now?: Date;
  maxAttempts?: number | string | null;
  folderActive?: boolean | null;
  contactSuppressed?: boolean | null;
  callback?: {
    status?: string | null;
    assignedSdrId?: string | null;
    dueAt?: Date | string | null;
  } | null;
  activeCall?: boolean | null;
  scheduleAllowed?: boolean | null;
  campaignAllowed?: boolean | null;
  manualQueueOverride?: boolean;
  sdrConnected?: boolean | null;
  sdrId?: string | null;
  sdrAvailable?: boolean | null;
  enforceSdrAvailability?: boolean;
  line?: {
    phone?: string | null;
    status?: string | null;
    flaggedUntil?: Date | string | null;
    lastCallEndedAt?: Date | string | null;
    cooldownSeconds?: number | string | null;
  } | null;
};

const connectedLineStatuses = new Set(['connected', 'online', 'ready', 'authenticated']);
const activeCallStatuses = new Set(['reserved', 'dialing', 'media_active']);
const callbackStatuses = new Set(['pending', 'due', 'reassigned']);
const automaticModes = new Set<EligibilityMode>(['automatic', 'preview', 'simulation']);

const asDate = (value: Date | string | null | undefined) => {
  if (value instanceof Date) return value;
  if (value == null) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};

const digits = (value: unknown) => String(value ?? '').replace(/\D/g, '');

export function evaluateLeadEligibility(input: LeadEligibilityInput): EligibilityResult {
  const now = input.now ?? new Date();
  const reasons: EligibilityReason[] = [];
  const queueOverride = input.mode === 'manual' && input.manualQueueOverride === true;
  const enforceQueue = automaticModes.has(input.mode) || !queueOverride;
  const add = (code: RoadmapReasonCode, allowed: boolean, metadata?: Record<string, unknown>) => {
    reasons.push({ code, allowed, ...(metadata ? { metadata } : {}) });
  };

  if (input.campaignAllowed !== undefined && input.campaignAllowed !== null) {
    add(input.campaignAllowed ? 'campaign_running' : 'campaign_not_running', Boolean(input.campaignAllowed));
  }
  if (input.scheduleAllowed !== undefined && input.scheduleAllowed !== null) {
    add(input.scheduleAllowed ? 'within_schedule' : 'outside_schedule', Boolean(input.scheduleAllowed));
  }
  // An inactive folder pauses the automatic queue, not an explicit call made
  // by a person. This is part of the same manual queue override as status,
  // attempt budget and next-attempt pacing.
  if (enforceQueue && input.folderActive !== undefined && input.folderActive !== null) {
    add(input.folderActive ? 'folder_active' : 'folder_inactive', Boolean(input.folderActive));
  }

  const doNotCall = Boolean(input.lead.doNotCall);
  const contactSuppressed = Boolean(input.contactSuppressed);
  add(doNotCall || contactSuppressed ? 'contact_suppressed' : 'not_suppressed', !(doNotCall || contactSuppressed));

  const activeCall = Boolean(input.activeCall);
  add(activeCall ? 'active_call' : 'no_active_call', !activeCall);

  const callback = input.callback;
  if (callback?.status && callbackStatuses.has(String(callback.status))) {
    if (callback.assignedSdrId) {
      const ownedByAnother = !input.sdrId || callback.assignedSdrId !== input.sdrId;
      const callbackDueAt = asDate(callback.dueAt);
      const callbackIsDue = ['due', 'reassigned'].includes(String(callback.status)) && (!callbackDueAt || callbackDueAt.getTime() <= now.getTime());
      const manualDueCallback = input.mode === 'manual' && callbackIsDue && !ownedByAnother;
      add(ownedByAnother ? 'callback_owned_by_another_sdr' : 'callback_due', manualDueCallback);
    } else {
      add(callback.status === 'due' ? 'callback_due' : 'callback_pending', false);
    }
  } else if (input.callback !== undefined) {
    add('callback_due', true);
  }

  if (queueOverride) add('manual_queue_override', true);
  if (enforceQueue) {
    const status = String(input.lead.status ?? '');
    const statusAllowed = ['queued', 'retry_wait'].includes(status);
    add(statusAllowed ? 'lead_status_eligible' : 'lead_status_ineligible', statusAllowed);

    const attempts = Number(input.lead.attempts ?? 0);
    const maxAttempts = Number(input.maxAttempts ?? Number.POSITIVE_INFINITY);
    const attemptAllowed = Number.isFinite(attempts) && attempts < maxAttempts;
    add(attemptAllowed ? 'attempt_budget_ok' : 'attempt_budget_exhausted', attemptAllowed, { attempts, maxAttempts });

    const nextEligibleAt = asDate(input.lead.nextEligibleAt);
    const due = !nextEligibleAt || nextEligibleAt.getTime() <= now.getTime();
    add(due ? 'next_attempt_due' : 'next_attempt_wait', due, nextEligibleAt ? { nextEligibleAt: nextEligibleAt.toISOString() } : undefined);
  }

  if (input.sdrConnected !== undefined && input.sdrConnected !== null) {
    add(input.sdrConnected ? 'sdr_available' : 'no_sdr_available', Boolean(input.sdrConnected));
  }
  if (input.enforceSdrAvailability && input.sdrAvailable !== undefined && input.sdrAvailable !== null) {
    add(input.sdrAvailable ? 'sdr_available' : 'no_sdr_available', Boolean(input.sdrAvailable));
  }

  if (input.line) {
    const lineStatus = String(input.line.status ?? '').toLowerCase();
    const lineConnected = connectedLineStatuses.has(lineStatus);
    add(lineConnected ? 'line_connected' : 'line_disconnected', lineConnected);
    const flaggedUntil = asDate(input.line.flaggedUntil);
    if (flaggedUntil && flaggedUntil.getTime() > now.getTime()) add('line_quarantined', false, { flaggedUntil: flaggedUntil.toISOString() });
    const lastCallEndedAt = asDate(input.line.lastCallEndedAt);
    const protectedLine = Boolean(lastCallEndedAt && lastCallEndedAt.getTime() > now.getTime());
    if (protectedLine) add('line_protected', false, { protectedUntil: lastCallEndedAt?.toISOString() });
    const cooldownSeconds = Number(input.line.cooldownSeconds ?? 0);
    const cooldownReady = !lastCallEndedAt || lastCallEndedAt.getTime() + Math.max(0, cooldownSeconds) * 1000 <= now.getTime();
    if (input.mode === 'automatic') add(cooldownReady ? 'line_cooldown' : 'line_cooldown', cooldownReady, { cooldownSeconds });
    const leadPhone = digits(input.lead.phone);
    const linePhone = digits(input.line.phone);
    if (leadPhone && linePhone && leadPhone === linePhone) add('self_call', false);
  }

  const blockedBy = reasons.filter((reason) => !reason.allowed).map((reason) => reason.code);
  return {
    eligible: blockedBy.length === 0,
    mode: input.mode,
    reasons,
    reasonCodes: reasons.map((reason) => reason.code),
    blockedBy: [...new Set(blockedBy)],
    checkedAt: now.toISOString(),
  };
}

export function eligibilityErrorMessage(result: EligibilityResult) {
  const code = result.blockedBy[0];
  const messages: Partial<Record<RoadmapReasonCode, string>> = {
    outside_schedule: 'Fora do horario permitido para chamadas',
    contact_suppressed: 'Este telefone esta na lista de nao contato',
    active_call: 'Este lead ja possui uma chamada ativa',
    callback_owned_by_another_sdr: 'Este retorno esta atribuido a outro SDR',
    callback_due: 'Este lead possui um retorno pendente',
    callback_pending: 'Este lead possui um retorno pendente',
    lead_status_ineligible: 'Este lead nao esta elegivel para uma chamada',
    attempt_budget_exhausted: 'O limite de tentativas deste lead foi atingido',
    next_attempt_wait: 'Aguarde o horario da proxima tentativa',
    no_sdr_available: 'Nenhum SDR conectado e disponivel',
    line_disconnected: 'Nenhum numero WhatsApp conectado',
    line_quarantined: 'A linha WhatsApp esta temporariamente protegida por limite de chamadas',
    line_protected: 'A linha WhatsApp esta temporariamente protegida por limite de chamadas',
    line_cooldown: 'A linha WhatsApp ainda esta em cooldown',
    self_call: 'O numero de destino e a propria linha de WhatsApp conectada',
    campaign_not_running: 'A campanha deste lead nao esta em execucao ou nao possui recursos disponiveis',
    folder_inactive: 'A pasta deste lead esta inativa',
  };
  return messages[code] ?? 'Este lead nao esta elegivel para uma chamada';
}

@Injectable()
export class EligibilityService {
  constructor(private readonly db: DatabaseService) {}

  evaluate(input: LeadEligibilityInput) {
    return evaluateLeadEligibility(input);
  }

  async inspectLead(tenantId: string, leadId: string, mode: EligibilityMode = 'preview') {
    const result = await this.db.query(`
      SELECT l.id, l.name, l.phone, l.status, l.attempts, l.next_eligible_at, l.do_not_call,
        f.is_active AS folder_active,
        EXISTS (SELECT 1 FROM contact_suppressions cs WHERE cs.tenant_id = l.tenant_id AND cs.phone = l.phone AND cs.lifted_at IS NULL) AS contact_suppressed,
        EXISTS (SELECT 1 FROM calls active_call WHERE active_call.tenant_id = l.tenant_id AND active_call.lead_id = l.id AND active_call.status IN ('reserved','dialing','media_active')) AS active_call,
        callback.status AS callback_status, callback.assigned_sdr_id AS callback_assigned_sdr_id, callback.due_at AS callback_due_at,
        COALESCE(ds.max_attempts_per_lead, 2) AS max_attempts
      FROM leads l
      JOIN lead_folders f ON f.tenant_id = l.tenant_id AND f.id = l.folder_id
      LEFT JOIN LATERAL (
        SELECT cb.status, cb.assigned_sdr_id, cb.due_at
        FROM lead_callbacks cb
        WHERE cb.tenant_id = l.tenant_id AND cb.lead_id = l.id AND cb.status IN ('pending','due','reassigned')
        ORDER BY cb.due_at ASC
        LIMIT 1
      ) callback ON true
      LEFT JOIN dialer_settings ds ON ds.tenant_id = l.tenant_id
      WHERE l.tenant_id = $1 AND l.id = $2
    `, [tenantId, leadId]);
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Lead nao encontrado');
    const evaluation = this.evaluate({
      mode,
      lead: { id: row.id, phone: row.phone, status: row.status, attempts: row.attempts, nextEligibleAt: row.next_eligible_at, doNotCall: row.do_not_call },
      maxAttempts: row.max_attempts,
      folderActive: row.folder_active,
      contactSuppressed: row.contact_suppressed,
      activeCall: row.active_call,
      callback: row.callback_status ? { status: row.callback_status, assignedSdrId: row.callback_assigned_sdr_id, dueAt: row.callback_due_at } : null,
    });
    return { lead: { id: row.id, name: row.name, status: row.status, attempts: row.attempts, next_eligible_at: row.next_eligible_at }, ...evaluation };
  }
}
