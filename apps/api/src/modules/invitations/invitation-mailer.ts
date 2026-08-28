import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';

export type InvitationMessage = { email: string; tenantName: string; role: string; invitationUrl: string };

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/\"/g, '&quot;')
  .replace(/'/g, '&#39;');

@Injectable()
export class InvitationMailer {
  private readonly logger = new Logger(InvitationMailer.name);
  private readonly transporter?: Transporter;

  constructor() {
    const host = String(process.env.SMTP_HOST ?? '').trim();
    if (!host) return;
    this.transporter = nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD ?? '' } : undefined,
    });
  }

  async send(message: InvitationMessage) {
    if (this.transporter) {
      const tenantName = escapeHtml(message.tenantName);
      const role = escapeHtml(message.role);
      const invitationUrl = escapeHtml(message.invitationUrl);
      await this.transporter.sendMail({
        from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
        to: message.email,
        subject: `Convite para entrar na empresa ${message.tenantName}`,
        text: `Você foi convidado para a empresa ${message.tenantName} no ZapCall como ${message.role}. Acesse: ${message.invitationUrl}`,
        html: `<p>Você foi convidado para a empresa <strong>${tenantName}</strong> no ZapCall como <strong>${role}</strong>.</p><p><a href="${invitationUrl}">Aceitar convite</a></p>`,
      });
      return;
    }
    if (process.env.NODE_ENV === 'production') throw new Error('SMTP_HOST é obrigatório para enviar convites em produção');
    if (process.env.NODE_ENV !== 'production') {
      this.logger.log(`Convite preparado para ${message.email} na empresa ${message.tenantName} (${message.role})`);
    }
  }
}
