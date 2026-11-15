/** Shared RTL/LTR transactional email template using Tammha's approved banner. */
export type EmailLanguage = 'ar' | 'en';
/** The SMTP adapter attaches the real PNG under this content ID. */
export const TAMMHA_EMAIL_BANNER_CID = 'tammha-banner@tammha.site';

export function emailLanguage(value: unknown): EmailLanguage {
  return value === 'en' ? 'en' : 'ar';
}

export function escapeEmailHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only allow http(s) destination links. The trusted caller supplies the origin. */
export function emailActionUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      return parsed.toString();
  } catch {
    // Omit invalid URLs instead of rendering them in email HTML.
  }
  return '';
}

export function renderTammhaMail(input: {
  language: EmailLanguage;
  subject: string;
  body: string;
  recipientName?: string | null;
  buttonLabel?: string;
  actionUrl?: string;
}): { subject: string; text: string; html: string } {
  const { language, body } = input;
  const ar = language === 'ar';
  const direction = ar ? 'rtl' : 'ltr';
  const align = ar ? 'right' : 'left';
  const subject = input.subject.replace(/[\r\n]/g, ' ').slice(0, 200);
  const name = input.recipientName?.trim().slice(0, 120) ?? '';
  const greeting = ar
    ? `مرحبًا${name ? ` ${name}` : ''}،`
    : `Hello${name ? ` ${name}` : ''},`;
  const footer = ar
    ? 'هذه رسالة آلية من منصة تممها بخصوص حسابك أو مشروعك.\n© 2026 تممها. جميع الحقوق محفوظة.'
    : 'This is an automated email from Tammha about your account or project.\n© 2026 Tammha. All rights reserved.';
  const link = input.actionUrl ? emailActionUrl(input.actionUrl) : '';
  const label = input.buttonLabel ?? (ar ? 'الدخول إلى تممها' : 'Open Tammha');
  const backup = ar
    ? 'إذا لم يعمل الزر، استخدم الرابط التالي:'
    : 'If the button does not work, use this link:';
  const text = `${greeting}\n\n${body}${link ? `\n\n${label}: ${link}\n${backup}\n${link}` : ''}\n\n${footer}`;
  const safeLink = escapeEmailHtml(link);
  const linkBlock = link
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:22px 0 16px;border-collapse:collapse"><tr><td align="center" style="padding:19px 12px;background:#f1f6ff;border:1px solid #e4edfb;border-radius:8px"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate"><tr><td align="center" bgcolor="#0958bb" style="background:#0958bb;border-radius:6px"><a href="${safeLink}" target="_blank" style="display:inline-block;padding:11px 24px;color:#ffffff;font-family:Tahoma,Arial,sans-serif;font-weight:700;font-size:14px;line-height:20px;text-decoration:none">${escapeEmailHtml(label)}</a></td></tr></table></td></tr></table>` +
      `<p style="margin:0;color:#5d6571;font-size:11px;line-height:1.75;overflow-wrap:anywhere">${escapeEmailHtml(backup)} <a href="${safeLink}" style="color:#0958bb;text-decoration:underline;word-break:break-all">${safeLink}</a></p>`
    : '';
  const renderedBody = escapeEmailHtml(body).replace(/\n/g, '<br>');
  const html =
    `<!doctype html><html lang="${language}" dir="${direction}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"></head>` +
    `<body style="margin:0;padding:20px 8px;background:#f2f4f8;color:#202b3e;font-family:Tahoma,Arial,sans-serif">` +
    `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 auto;max-width:600px;border-collapse:separate;background:#ffffff;border:1px solid #e0e5ed">` +
    `<tr><td style="padding:0;background:#064394"><img src="cid:${TAMMHA_EMAIL_BANNER_CID}" alt="تممها - TAMMHA" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none;text-decoration:none"></td></tr>` +
    `<tr><td dir="${direction}" align="${align}" style="padding:27px 32px 30px;text-align:${align};direction:${direction}">` +
    `<h1 style="color:#132c55;font-size:18px;font-weight:700;line-height:1.55;margin:0 0 21px">${escapeEmailHtml(subject)}</h1>` +
    `<p style="color:#293447;font-size:14px;line-height:1.95;margin:0 0 13px">${escapeEmailHtml(greeting)}</p>` +
    `<p style="color:#293447;font-size:14px;line-height:2;margin:0">${renderedBody}</p>${linkBlock}</td></tr>` +
    `<tr><td align="center" style="padding:19px 22px;background:#f8fafc;border-top:1px solid #e6ebf2;text-align:center;color:#687589;font-size:11px;line-height:1.85">${escapeEmailHtml(footer).replace(/\n/g, '<br>')}</td></tr>` +
    `</table></body></html>`;
  return { subject, text, html };
}
