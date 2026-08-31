import { Injectable, Logger, Optional } from '@nestjs/common';
import { Resend } from 'resend';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { renderZapLigaEmail } from '../../infrastructure/email/email-template';

export type InvitationMessage = { email: string; tenantName: string; role: string; invitationUrl: string };

const isRealDeployment = () => process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test';

@Injectable()
export class InvitationMailer {
  private readonly logger = new Logger(InvitationMailer.name);
  private readonly resend?: Resend;

  constructor(@Optional() private readonly redis?: RedisService) {
    const apiKey = String(process.env.RESEND_API_KEY ?? '').trim();
    if (apiKey) this.resend = new Resend(apiKey);
  }

  async send(message: InvitationMessage) {
    const startedAt = Date.now();
    try {
      if (this.resend) {
        const roleLabel = message.role === 'leader' ? 'Organizador' : message.role === 'sdr' ? 'SDR' : message.role;
        const { error } = await this.resend.emails.send({
          from: process.env.RESEND_FROM ?? '',
          to: message.email,
          subject: `Convite para entrar na empresa ${message.tenantName}`,
          text: `Você foi convidado para a empresa ${message.tenantName} no ZapLiga como ${roleLabel}. Acesse: ${message.invitationUrl}`,
          html: renderZapLigaEmail({
            preheader: `Você foi convidado para participar da operação ${message.tenantName}.`,
            eyebrow: 'Convite para sua equipe',
            title: 'Você foi convidado para o ZapLiga',
            paragraphs: [`Você recebeu um convite para participar da empresa ${message.tenantName} como ${roleLabel}. Aceite o convite para criar seu acesso e começar.`],
            action: { label: 'Aceitar convite', url: message.invitationUrl },
            footnote: 'Se você não esperava este convite, pode ignorar esta mensagem.',
          }),
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
