import { Injectable, Logger, Optional } from '@nestjs/common';
import { Resend } from 'resend';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { renderZapLigaEmail } from '../../infrastructure/email/email-template';

@Injectable()
export class AccountMailer {
  private readonly logger = new Logger(AccountMailer.name);
  private readonly resend?: Resend;

  constructor(@Optional() private readonly redis?: RedisService) {
    const key = String(process.env.RESEND_API_KEY ?? '').trim();
    if (key) this.resend = new Resend(key);
  }

  private async send(email: string, subject: string, text: string, html: string) {
    const startedAt = Date.now();
    try {
      if (!this.resend) {
        this.logger.log(`${subject} preparado para ambiente local`);
        return;
      }
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
    return this.send(
      email,
      'Verifique seu e-mail no ZapLiga',
      `Olá, ${name}. Verifique seu e-mail acessando: ${url}. Este link expira em 24 horas.`,
      renderZapLigaEmail({
        preheader: 'Confirme seu endereço de e-mail para começar a usar o ZapLiga.',
        eyebrow: 'Sua conta ZapLiga',
        title: 'Confirme seu e-mail',
        greeting: name,
        paragraphs: ['Falta pouco para começar. Confirme seu endereço de e-mail para ativar sua conta e acessar sua operação.'],
        action: { label: 'Verificar meu e-mail', url },
        footnote: 'Este link é válido por 24 horas. Se você não criou uma conta no ZapLiga, pode ignorar esta mensagem.',
      }),
    );
  }

  passwordReset(email: string, name: string, token: string) {
    const url = `${String(process.env.WEB_ORIGIN ?? 'http://localhost:5173').split(',')[0].replace(/\/$/, '')}/redefinir-senha?token=${encodeURIComponent(token)}`;
    return this.send(
      email,
      'Redefina sua senha do ZapLiga',
      `Olá, ${name}. Redefina sua senha acessando: ${url}. Este link expira em 30 minutos.`,
      renderZapLigaEmail({
        preheader: 'Use este link para criar uma nova senha no ZapLiga.',
        eyebrow: 'Segurança da conta',
        title: 'Redefina sua senha',
        greeting: name,
        paragraphs: ['Recebemos uma solicitação para criar uma nova senha para sua conta. Clique no botão abaixo para continuar.'],
        action: { label: 'Redefinir minha senha', url },
        footnote: 'Este link expira em 30 minutos. Se você não solicitou a alteração, ignore este e-mail; sua senha continuará a mesma.',
      }),
    );
  }

  passwordChanged(email: string, name: string) {
    return this.send(
      email,
      'Sua senha do ZapLiga foi alterada',
      `Olá, ${name}. Sua senha foi alterada. Se não foi você, solicite uma redefinição agora.`,
      renderZapLigaEmail({
        preheader: 'Sua senha do ZapLiga foi alterada.',
        eyebrow: 'Segurança da conta',
        title: 'Senha alterada com sucesso',
        greeting: name,
        paragraphs: ['A senha da sua conta foi alterada. Se foi você, nenhuma ação é necessária.', 'Se você não reconhece essa alteração, redefina sua senha imediatamente pela tela de login.'],
        footnote: 'Por segurança, nunca compartilhe sua senha ou códigos de acesso.',
      }),
    );
  }
}
