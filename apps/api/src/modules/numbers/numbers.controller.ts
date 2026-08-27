import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { WaxumClient } from '../../infrastructure/waxum/waxum.client';
import { normalizeWaxumStatus } from '../../infrastructure/waxum/waxum-status';

const digits = (value: unknown) => String(value ?? '').replace(/\D/g, '');

@Controller()
export class NumbersController {
  private readonly qrRequests = new Map<string, Promise<any>>();

  constructor(private readonly db: DatabaseService, private readonly waxum: WaxumClient) {}

  @Post('/api/numbers')
  async create(@Body() body: any) {
    const label = String(body.label ?? body.name ?? '').trim();
    if (!label) throw new BadRequestException('label é obrigatório');
    try {
      const session = await this.waxum.createSession(label);
      const result = await this.db.query(`INSERT INTO whatsapp_numbers (id,label,phone,waxum_session_id,max_concurrent_calls,cooldown_seconds) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [randomUUID(), label, digits(body.phone) || null, session.id, Number(body.maxConcurrentCalls ?? 1), Number(body.cooldownSeconds ?? 60)]);
      return result.rows[0];
    } catch (error) { throw new BadRequestException(`Não foi possível criar a sessão Waxum: ${String(error)}`); }
  }

  @Get('/api/numbers')
  list() { return this.db.query("SELECT * FROM whatsapp_numbers WHERE status <> 'removed' ORDER BY created_at DESC").then((result) => result.rows); }

  @Delete('/api/numbers/:id')
  async remove(@Param('id') id: string) {
    const number = await this.find(id);
    const active = await this.db.query("SELECT 1 FROM calls WHERE number_id = $1 AND status IN ('reserved', 'dialing', 'media_active') LIMIT 1", [id]);
    if (active.rows[0]) throw new BadRequestException('Nao e possivel remover um numero durante uma chamada');

    try {
      await this.waxum.deleteSession(number.waxum_session_id);
    } catch (error) {
      const statusCode = (error as Error & { statusCode?: number }).statusCode;
      if (statusCode !== 404) throw new BadRequestException(`Nao foi possivel remover a sessao Waxum: ${String(error)}`);
    }

    await this.db.query("UPDATE whatsapp_numbers SET status = 'removed' WHERE id = $1", [id]);
    return { ok: true, id, archived: true };
  }

  @Get('/api/numbers/:id/qr')
  async qr(@Param('id') id: string) {
    const current = this.qrRequests.get(id);
    if (current) return current;
    const request = this.loadQr(id).finally(() => this.qrRequests.delete(id));
    this.qrRequests.set(id, request);
    return request;
  }

  @Post('/api/numbers/:id/reconnect')
  async reconnect(@Param('id') id: string) {
    let number = await this.find(id);
    try { return await this.waxum.reconnect(number.waxum_session_id); }
    catch (error) {
      if ((error as Error & { statusCode?: number }).statusCode !== 404) throw error;
      number = await this.replaceMissingSession(number);
      return this.waxum.reconnect(number.waxum_session_id);
    }
  }

  @Patch('/api/numbers/:id/settings')
  async settings(@Param('id') id: string, @Body() body: any) {
    const result = await this.db.query(`UPDATE whatsapp_numbers SET max_concurrent_calls = COALESCE($1,max_concurrent_calls), cooldown_seconds = COALESCE($2,cooldown_seconds), label = COALESCE($3,label) WHERE id = $4 AND status <> 'removed' RETURNING *`, [body.maxConcurrentCalls == null ? null : Number(body.maxConcurrentCalls), body.cooldownSeconds == null ? null : Number(body.cooldownSeconds), body.label ? String(body.label) : null, id]);
    if (!result.rows[0]) throw new NotFoundException('Número não encontrado');
    return result.rows[0];
  }

  private async find(id: string) {
    const result = await this.db.query('SELECT * FROM whatsapp_numbers WHERE id = $1', [id]);
    if (!result.rows[0]) throw new NotFoundException('Número não encontrado');
    return result.rows[0];
  }

  private async replaceMissingSession(number: any) {
    const session = await this.waxum.createSession(number.label);
    const result = await this.db.query(`UPDATE whatsapp_numbers SET waxum_session_id = $1, status = 'disconnected' WHERE id = $2 RETURNING *`, [session.id, number.id]);
    return result.rows[0];
  }

  private async loadQr(id: string) {
    let number = await this.find(id);
    let payload: any;
    try { payload = await this.loadQrFromSession(number.waxum_session_id); }
    catch (error) {
      if ((error as Error & { statusCode?: number }).statusCode !== 404) throw error;
      number = await this.replaceMissingSession(number);
      payload = await this.loadQrFromSession(number.waxum_session_id);
    }
    const status = await this.refreshNumberStatus(number);
    return status.connected ? { ...payload, status: 'connected', phone_number: status.phone } : payload;
  }

  private async refreshNumberStatus(number: any) {
    const status = normalizeWaxumStatus(await this.waxum.getStatus(number.waxum_session_id));
    await this.db.query('UPDATE whatsapp_numbers SET status = $1, phone = COALESCE($2, phone) WHERE id = $3', [status.status, status.phone, number.id]);
    return status;
  }

  private async loadQrFromSession(sessionId: string) {
    try {
      return await this.waitForQr(sessionId);
    } catch (error) {
      const typedError = error as Error & { statusCode?: number };
      // Newly-created sessions need /connect before Waxum can expose a QR.
      // Opening the QR in the panel should perform that transition for the operator.
      if (typedError.statusCode !== 503) throw error;
      await this.waxum.reconnect(sessionId);
      return this.waitForQr(sessionId);
    }
  }

  private async waitForQr(sessionId: string) {
    let last: any = { qr_codes: [], timeout_seconds: 60, status: 'waiting_for_qr' };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        last = await this.waxum.getQr(sessionId);
        if ((Array.isArray(last?.qr_codes) && last.qr_codes.length > 0) || (typeof last?.qr === 'string' && last.qr.length > 0)) return last;
      } catch (error) { if ((error as Error & { statusCode?: number }).statusCode !== 429) throw error; }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    return last;
  }
}
