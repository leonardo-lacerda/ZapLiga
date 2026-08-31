import { Injectable, Logger, Optional } from '@nestjs/common';
import { Resend } from 'resend';
import { RedisService } from '../../infrastructure/redis/redis.service';

export type InvitationMessage = { email: string; tenantName: string; role: string; invitationUrl: string };

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/\"/g, '&quot;')
  .replace(/'/g, '&#39;');

const isRealDeployment = () => process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test';

@Injectable()
export class InvitationMailer {
  private readonly logger = new Logger(InvitationMailer.name);
  private readonly resend?: Resend;

  constructor(@Optional() private readonly redis?: RedisService) {
    const apiKey = String(process.env.RESEND_API_KEY ?? '').trim();
    if (!apiKey) return;
    this.resend = new Resend(apiKey);
  }

  async send(message: InvitationMessage) {
    const startedAt = Date.now();
    try {
      if (this.resend) {
      const tenantName = escapeHtml(message.tenantName);
      const role = escapeHtml(message.role);
      const invitationUrl = escapeHtml(message.invitationUrl);
      const { error } = await this.resend.emails.send({
        from: process.env.RESEND_FROM ?? '',
        to: message.email,
        subject: `Convite para entrar na empresa ${message.tenantName}`,
        text: `Você foi convidado para a empresa ${message.tenantName} no ZapLiga como ${message.role}. Acesse: ${message.invitationUrl}`,
        html: `<p>Você foi convidado para a empresa <strong>${tenantName}</strong> no ZapLiga como <strong>${role}</strong>.</p><p><a href="${invitationUrl}">Aceitar convite</a></p>`,
      });
      if (error) throw new Error(`Falha ao enviar convite via Resend: ${error.message}`);
        await this.redis?.incrementMetric('emails_sent_total');
        return;
      }
      if (isRealDeployment()) throw new Error('RESEND_API_KEY é obrigatório para enviar convites em produção');
      this.logger.log(`Convite preparado para ambiente local na empresa ${message.tenantName} (${message.role})`);
    } catch (error) {
      await this.redis?.incrementMetric('emails_failed_total');
      throw error;
    } finally {
      await this.redis?.observeMetric('email_delivery', Date.now() - startedAt);
    }
  }
}
