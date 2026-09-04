import { BadRequestException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { DialerService } from '../dialer/dialer.service';

@Injectable()
export class CallbacksService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly dialer: DialerService) {}

  async sdrIdForUser(tenantId: string, userId: string) {
    return (await this.db.query('SELECT id FROM sdrs WHERE tenant_id = $1 AND user_id = $2 LIMIT 1', [tenantId, userId])).rows[0]?.id as string | undefined;
  }

  async list(tenantId: string, input: { assignedSdrId?: string; status?: string; userSdrId?: string }) {
    const due = await this.db.query(`UPDATE lead_callbacks SET status = 'due', updated_at = now() WHERE tenant_id = $1 AND status IN ('pending', 'reassigned') AND due_at <= now() RETURNING id`, [tenantId]);
    for (const row of due?.rows ?? []) await this.audit.record({ tenantId, action: 'callback.due', entityType: 'callback', entityId: row.id }).catch(() => undefined);
    const params: unknown[] = [tenantId]; const conditions = ["cb.tenant_id = $1"];
    if (input.userSdrId) {
      params.push(input.userSdrId);
      // Explicitly released callbacks are visible to the team; callbacks
      // still owned by another SDR remain private to that owner.
      conditions.push(`(cb.assigned_sdr_id = $${params.length} OR cb.assigned_sdr_id IS NULL)`);
    } else if (input.assignedSdrId) {
      params.push(input.assignedSdrId); conditions.push(`cb.assigned_sdr_id = $${params.length}`);
    }
    if (input.status) { params.push(input.status); conditions.push(`cb.status = $${params.length}`); }
    const result = await this.db.query(`SELECT cb.*, l.name AS lead_name, l.phone AS lead_phone, l.do_not_call,
      s.name AS assigned_sdr_name,
      CASE WHEN cb.status IN ('pending', 'due', 'reassigned') AND cb.due_at <= now() THEN true ELSE false END AS overdue
      FROM lead_callbacks cb JOIN leads l ON l.tenant_id = cb.tenant_id AND l.id = cb.lead_id
      LEFT JOIN sdrs s ON s.tenant_id = cb.tenant_id AND s.id = cb.assigned_sdr_id
      WHERE ${conditions.join(' AND ')} ORDER BY CASE WHEN cb.status IN ('pending','due','reassigned') THEN 0 ELSE 1 END, cb.due_at ASC LIMIT 500`, params);
    return result.rows;
  }

  private async requireActive(tenantId: string, id: string) {
    const result = await this.db.query(`SELECT * FROM lead_callbacks WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
    if (!result.rows[0]) throw new NotFoundException('Retorno não encontrado');
    return result.rows[0];
  }

  async reschedule(tenantId: string, id: string, dueAt: string, notes: string | undefined, actorUserId: string, ownSdrId?: string) {
    const date = new Date(dueAt); if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw new BadRequestException('Informe uma data futura');
    const current = await this.requireActive(tenantId, id); if (ownSdrId && current.assigned_sdr_id !== ownSdrId) throw new ForbiddenException('Este retorno pertence a outro SDR');
    const result = await this.db.query(`UPDATE lead_callbacks SET due_at = $1, notes = COALESCE($2, notes), status = 'pending', updated_by_user_id = $3, updated_at = now() WHERE tenant_id = $4 AND id = $5 AND status IN ('pending','due','reassigned') RETURNING *`, [date, notes?.trim() || null, actorUserId, tenantId, id]);
    if (!result.rows[0]) throw new BadRequestException('Este retorno já foi encerrado');
    await this.audit.record({ actorUserId, tenantId, action: 'callback.rescheduled', entityType: 'callback', entityId: id, metadata: { dueAt: date.toISOString() } }); return result.rows[0];
  }

  async reassign(tenantId: string, ids: string[], assignedSdrId: string | undefined, actorUserId: string) {
    if (assignedSdrId) {
      const exists = await this.db.query(`SELECT 1 FROM sdrs s
        JOIN tenant_memberships tm ON tm.tenant_id = s.tenant_id AND tm.user_id = s.user_id AND tm.role = 'sdr' AND tm.status = 'active'
        WHERE s.tenant_id = $1 AND s.id = $2`, [tenantId, assignedSdrId]);
      if (!exists.rows[0]) throw new BadRequestException('SDR não encontrado ou inativo');
    }
    const result = await this.db.query(`UPDATE lead_callbacks SET assigned_sdr_id = $1, status = 'reassigned', updated_by_user_id = $2, updated_at = now() WHERE tenant_id = $3 AND id = ANY($4::uuid[]) AND status IN ('pending','due','reassigned') RETURNING *`, [assignedSdrId ?? null, actorUserId, tenantId, ids]);
    await this.audit.record({ actorUserId, tenantId, action: 'callback.reassigned', entityType: 'callback', metadata: { ids, assignedSdrId: assignedSdrId ?? null, updated: result.rowCount ?? 0 } }); return result.rows;
  }

  async cancel(tenantId: string, id: string, reason: string, status: 'cancelled' | 'missed', actorUserId: string, ownSdrId?: string) {
    const current = await this.requireActive(tenantId, id); if (ownSdrId && current.assigned_sdr_id !== ownSdrId) throw new ForbiddenException('Este retorno pertence a outro SDR');
    const result = await this.db.query(`UPDATE lead_callbacks SET status = $1, notes = concat_ws(E'\n', NULLIF(notes,''), $2), cancelled_at = now(), updated_by_user_id = $3, updated_at = now() WHERE tenant_id = $4 AND id = $5 AND status IN ('pending','due','reassigned') RETURNING *`, [status, reason.trim(), actorUserId, tenantId, id]);
    if (!result.rows[0]) throw new BadRequestException('Este retorno já foi encerrado');
    await this.audit.record({ actorUserId, tenantId, action: `callback.${status}`, entityType: 'callback', entityId: id, metadata: { reason } }); return result.rows[0];
  }

  async callNow(tenantId: string, id: string, actorUserId: string, sdrUserId?: string) {
    const callback = await this.requireActive(tenantId, id); if (!['pending', 'due', 'reassigned'].includes(callback.status)) throw new BadRequestException('Este retorno já foi encerrado');
    if (sdrUserId) {
      const own = await this.sdrIdForUser(tenantId, sdrUserId);
      if (!own || (callback.assigned_sdr_id && callback.assigned_sdr_id !== own)) throw new ForbiddenException('Este retorno pertence a outro SDR');
    }
    // Preserve callback ownership when a leader starts the call: an assigned
    // callback must not silently jump to another connected SDR. A released
    // callback (null assignment) may still use normal team selection.
    let assignedUserId = sdrUserId;
    if (!assignedUserId && callback.assigned_sdr_id) {
      assignedUserId = (await this.db.query('SELECT user_id FROM sdrs WHERE tenant_id = $1 AND id = $2 LIMIT 1', [tenantId, callback.assigned_sdr_id])).rows[0]?.user_id;
      if (!assignedUserId) throw new BadRequestException('O SDR responsável não está mais disponível');
    }
    try {
      const result = await this.dialer.manualCallWithInput({ leadId: callback.lead_id }, tenantId, assignedUserId);
      await this.audit.record({ actorUserId, tenantId, action: 'callback.call_started', entityType: 'callback', entityId: id, metadata: { callId: result.callId } }); return result;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new BadRequestException(String(error instanceof Error ? error.message : error));
    }
  }
}
