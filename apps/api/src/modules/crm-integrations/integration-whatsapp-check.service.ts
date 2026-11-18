import { BadGatewayException, ConflictException, HttpException, HttpStatus, Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { WaxumClient } from '../../infrastructure/waxum/waxum.client';
import { CrmIntegration } from './crm-integrations.service';

const CONNECTED_STATUSES = ['connected', 'online', 'ready', 'authenticated'];
// Each check is a usync from a WhatsApp Web line, and lines that look numbers up in volume get
// banned. So: few lines tried, a per-tenant budget, and a cache shared by every tenant (whether a
// number has WhatsApp does not depend on who asks).
const MAX_LINES_TRIED = 2;
const checksPerMinute = () => Math.max(1, Number(process.env.CRM_WHATSAPP_CHECK_PER_MINUTE) || 10);
const cacheTtlSeconds = () => Math.max(60, Number(process.env.CRM_WHATSAPP_CHECK_CACHE_SECONDS) || 24 * 60 * 60);
const cacheKey = (digits: string) => `zapcall:whatsapp-check:${digits}`;

export type WhatsappCheckResult = { phone: string; on_whatsapp: boolean; jid: string | null };

/** E.164 with or without `+` (spaces, dashes, dots and parentheses tolerated) → digits, or null. */
export function normalizeE164(value: unknown) {
  if (typeof value !== 'string') return null;
  const compact = value.trim().replace(/[\s().-]/g, '');
  return /^\+?[1-9]\d{7,14}$/.test(compact) ? compact.replace(/^\+/, '') : null;
}

/**
 * Tells the CRM whether a phone has WhatsApp by asking one of the tenant's own WhatsApp Web lines.
 * It never answers `on_whatsapp: false` unless Waxum actually said so: a failed or inconclusive
 * check is a 502, because the CRM shows a negative to the agent as verified.
 */
@Injectable()
export class IntegrationWhatsappCheckService {
  private readonly logger = new Logger(IntegrationWhatsappCheckService.name);

  constructor(private readonly db: DatabaseService, private readonly redis: RedisService, private readonly waxum: WaxumClient) {}

  async check(integration: CrmIntegration, phone: unknown): Promise<WhatsappCheckResult> {
    const digits = normalizeE164(phone);
    if (!digits) throw new UnprocessableEntityException({ code: 'invalid_phone', message: 'Telefone inválido: use o formato E.164, por exemplo +5531989739997' });

    const cached = await this.readCache(digits);
    if (cached) return cached;

    const lines = await this.pickLines(integration.tenant_id);
    if (!lines.length) throw new ConflictException({ code: 'no_connected_number', message: 'Nenhuma linha de WhatsApp conectada para fazer a verificação' });
    await this.consumeBudget(integration.tenant_id);

    for (const sessionId of lines) {
      try {
        const found = await this.waxum.checkContact(sessionId, digits);
        // No row (or no JID) means Waxum did not conclude: treat it as a failure, never as "no".
        if (!found) throw new Error('resposta sem resultado');
        const result: WhatsappCheckResult = { phone: digits, on_whatsapp: found.isRegistered, jid: found.isRegistered ? found.jid : null };
        await this.redis.client.set(cacheKey(digits), JSON.stringify(result), 'EX', cacheTtlSeconds()).catch(() => undefined);
        return result;
      } catch (error) {
        this.logger.warn(`WhatsApp check failed on session ${sessionId}: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
      }
    }
    throw new BadGatewayException({ code: 'check_failed', message: 'Não foi possível verificar o número no WhatsApp agora; tente de novo' });
  }

  private async readCache(digits: string): Promise<WhatsappCheckResult | null> {
    try {
      const raw = await this.redis.client.get(cacheKey(digits));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as WhatsappCheckResult;
      return typeof parsed?.on_whatsapp === 'boolean' ? { phone: digits, on_whatsapp: parsed.on_whatsapp, jid: parsed.jid ?? null } : null;
    } catch {
      return null;
    }
  }

  // Only real Waxum lookups count against the budget; cache hits are free.
  private async consumeBudget(tenantId: string) {
    const window = Math.floor(Date.now() / 60_000);
    const key = `zapcall:whatsapp-check:rate:${tenantId}:${window}`;
    const count = await this.redis.client.incr(key);
    if (count === 1) await this.redis.client.expire(key, 70);
    if (count > checksPerMinute()) {
      throw new HttpException({ code: 'rate_limited', message: 'Limite de verificações de WhatsApp por minuto excedido', retry_after_seconds: 60 - Math.floor((Date.now() % 60_000) / 1000) }, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /** Connected lines of the tenant, idle and healthy ones first. */
  private async pickLines(tenantId: string) {
    const result = await this.db.query<{ waxum_session_id: string }>(`
      SELECT n.waxum_session_id
      FROM whatsapp_numbers n
      WHERE n.tenant_id = $1 AND n.status = ANY($2::text[]) AND n.waxum_session_id IS NOT NULL
      ORDER BY
        EXISTS (SELECT 1 FROM calls c WHERE c.number_id = n.id AND c.status IN ('reserved', 'dialing', 'media_active')) ASC,
        (n.flagged_until IS NOT NULL AND n.flagged_until > now()) ASC,
        random()
      LIMIT $3`, [tenantId, CONNECTED_STATUSES, MAX_LINES_TRIED]);
    return result.rows.map((row) => row.waxum_session_id);
  }
}
