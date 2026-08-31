import { Injectable, Logger, Optional } from '@nestjs/common';
import { Resend } from 'resend';
import { RedisService } from '../../infrastructure/redis/redis.service';

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

@Injectable()
export class AccountMailer {
  private readonly logger = new Logger(AccountMailer.name);
  private readonly resend?: Resend;
  constructor(@Optional() private readonly redis?: RedisService) { const key = String(process.env.RESEND_API_KEY ?? '').trim(); if (key) this.resend = new Resend(key); }

  private async send(email: string, subject: string, text: string, html: string) {
    const startedAt = Date.now();
    try {
      if (!this.resend) { this.logger.log(`${subject} preparado para ambiente local`); return; }
      const { error } = await this.resend.emails.send({ from: process.env.RESEND_FROM ?? '', to: email, subject, text, html });
      if (error) throw new Error(`Falha ao enviar e-mail: ${error.message}`);
      await this.redis?.incrementMetric('emails_sent_total');
    } catch (error) {
      await this.redis?.incrementMetric('emails_failed_total');
      throw error;
    } finally {
      await this.redis?.observeMetric('email_delivery', Date.now() - startedAt);
    }
  }

  verification(email: string, name: string, token: string) {
    const url = `${String(process.env.WEB_ORIGIN ?? 'http://localhost:5173').split(',')[0].replace(/\/$/, '')}/verificar-email?token=${encodeURIComponent(token)}`;
    return this.send(email, 'Verifique seu e-mail no ZapLiga', `Olá, ${name}. Verifique seu e-mail: ${url}`, `<p>Olá, <strong>${escapeHtml(name)}</strong>.</p><p><a href="${escapeHtml(url)}">Verificar meu e-mail</a></p><p>Este link expira em 24 horas.</p>`);
  }

  passwordReset(email: string, name: string, token: string) {
    const url = `${String(process.env.WEB_ORIGIN ?? 'http://localhost:5173').split(',')[0].replace(/\/$/, '')}/redefinir-senha?token=${encodeURIComponent(token)}`;
    return this.send(email, 'Redefina sua senha do ZapLiga', `Olá, ${name}. Redefina sua senha: ${url}`, `<p>Olá, <strong>${escapeHtml(name)}</strong>.</p><p><a href="${escapeHtml(url)}">Redefinir minha senha</a></p><p>Este link expira em 30 minutos. Ignore se você não fez o pedido.</p>`);
  }

  passwordChanged(email: string, name: string) {
    return this.send(email, 'Sua senha do ZapLiga foi alterada', `Olá, ${name}. Sua senha foi alterada. Se não foi você, solicite uma redefinição agora.`, `<p>Olá, <strong>${escapeHtml(name)}</strong>.</p><p>Sua senha foi alterada. Se não foi você, solicite uma redefinição agora.</p>`);
  }
}
