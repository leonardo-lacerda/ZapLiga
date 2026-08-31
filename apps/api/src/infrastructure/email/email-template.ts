const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

export type EmailTemplateOptions = {
  preheader: string;
  eyebrow: string;
  title: string;
  greeting?: string;
  paragraphs: string[];
  action?: { label: string; url: string };
  footnote?: string;
};

/** Responsive transactional email shell using inline styles for major clients. */
export const renderZapLigaEmail = (options: EmailTemplateOptions) => {
  const paragraphs = options.paragraphs
    .map((paragraph) => `<p style="margin:0 0 16px;color:#526277;font-size:15px;line-height:1.65;">${escapeHtml(paragraph)}</p>`)
    .join('');
  const action = options.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 26px;"><tr><td align="center" bgcolor="#0789e8" style="border-radius:8px;"><a href="${escapeHtml(options.action.url)}" style="display:inline-block;padding:14px 22px;border:1px solid #0789e8;border-radius:8px;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;">${escapeHtml(options.action.label)}</a></td></tr></table>`
    : '';
  const footnote = options.footnote
    ? `<p style="margin:22px 0 0;padding-top:18px;border-top:1px solid #e7edf4;color:#8290a3;font-size:12px;line-height:1.6;">${escapeHtml(options.footnote)}</p>`
    : '';

  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(options.title)} · ZapLiga</title>
  </head>
  <body style="margin:0;background:#f4f8fc;font-family:Arial,Helvetica,sans-serif;color:#10233d;">
    <span style="display:none!important;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(options.preheader)}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f8fc;">
      <tr><td align="center" style="padding:34px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
          <tr><td style="padding:0 8px 22px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td width="38" height="38" align="center" valign="middle" bgcolor="#0789e8" style="width:38px;height:38px;border-radius:10px;color:#ffffff;font-size:20px;font-weight:700;">Z</td>
              <td style="padding-left:10px;color:#10233d;font-size:20px;font-weight:700;">ZapLiga</td>
            </tr></table>
          </td></tr>
          <tr><td style="background:#ffffff;border:1px solid #e3eaf2;border-radius:14px;padding:36px 38px;">
            <p style="margin:0 0 12px;color:#0789e8;font-size:11px;font-weight:700;letter-spacing:1.3px;text-transform:uppercase;">${escapeHtml(options.eyebrow)}</p>
            <h1 style="margin:0 0 24px;color:#10233d;font-size:27px;line-height:1.2;font-weight:700;">${escapeHtml(options.title)}</h1>
            ${options.greeting ? `<p style="margin:0 0 16px;color:#526277;font-size:15px;line-height:1.65;">Olá, <strong style="color:#10233d;">${escapeHtml(options.greeting)}</strong>.</p>` : ''}
            ${paragraphs}
            ${action}
            ${footnote}
          </td></tr>
          <tr><td align="center" style="padding:22px 12px 0;color:#8b98a9;font-size:12px;line-height:1.6;">
            <p style="margin:0;">Operação mais inteligente, todos os dias.</p>
            <p style="margin:5px 0 0;">Este é um e-mail automático do ZapLiga.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
};
