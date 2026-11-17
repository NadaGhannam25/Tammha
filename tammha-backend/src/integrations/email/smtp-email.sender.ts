import { createTransport } from 'nodemailer';
import { existsSync } from 'fs';
import { join } from 'path';
import { TAMMHA_EMAIL_BANNER_CID } from '@/common/email/email-layout';
import { EmailMessage, EmailSendResult, EmailSender } from './email.sender';

/** Smallest SMTP surface the sender needs (nodemailer's Transporter fits it). */
export interface SmtpTransport {
  sendMail(mail: {
    from: string;
    to: string | string[];
    subject: string;
    text: string;
    html?: string;
    replyTo?: string;
    headers?: Record<string, string>;
    attachments?: Array<{
      filename: string;
      path: string;
      cid: string;
      contentType: string;
      contentDisposition: 'inline' | 'attachment';
    }>;
  }): Promise<{
    messageId?: string;
    accepted?: unknown[];
    rejected?: unknown[];
  }>;
  verify?(): Promise<unknown>;
  close?(): void;
}

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
  replyTo: string | null;
  timeoutMs: number;
}

/** nodemailer transport (pooled connections; TLS required). */
export function createSmtpTransport(settings: SmtpSettings): SmtpTransport {
  const local = /^(localhost|127\.0\.0\.1)$/.test(settings.host);
  return createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    // STARTTLS is mandatory on non-TLS ports (plain text only for a local dev relay)
    requireTLS: !settings.secure && !local,
    auth: { user: settings.user, pass: settings.password },
    pool: true,
    maxConnections: 3,
    connectionTimeout: settings.timeoutMs,
    greetingTimeout: settings.timeoutMs,
    socketTimeout: settings.timeoutMs * 2,
    tls: { minVersion: 'TLSv1.2' },
  });
}

/** Stable error codes; the provider's message text (may contain addresses) is never kept. */
export function smtpErrorCode(error: unknown): string {
  const e = error as { code?: unknown; responseCode?: unknown };
  const code = typeof e?.code === 'string' ? e.code : '';
  const status = typeof e?.responseCode === 'number' ? e.responseCode : null;
  if (code === 'EAUTH' || status === 535 || status === 534)
    return 'EMAIL_AUTH_FAILED';
  if (
    ['ETIMEDOUT', 'ESOCKET', 'ECONNECTION', 'ECONNREFUSED', 'EDNS'].includes(
      code,
    )
  ) {
    return code === 'ETIMEDOUT' ? 'EMAIL_TIMEOUT' : 'EMAIL_CONNECTION_FAILED';
  }
  if (
    code === 'EENVELOPE' ||
    (status !== null && status >= 550 && status < 560)
  ) {
    return 'EMAIL_RECIPIENT_REJECTED';
  }
  if (status !== null && status >= 400 && status < 500)
    return 'EMAIL_TEMPORARY_FAILURE';
  if (code === 'EMESSAGE') return 'EMAIL_MESSAGE_REJECTED';
  return 'EMAIL_SEND_FAILED';
}

/**
 * Codes that retrying the same message cannot fix (the outbox marks them FAILED at once).
 * EMAIL_AUTH_FAILED stays retryable: fixed credentials deliver the queued e-mails.
 */
export const PERMANENT_EMAIL_ERRORS = [
  'EMAIL_RECIPIENT_REJECTED',
  'EMAIL_MESSAGE_REJECTED',
] as const;

/**
 * EMAIL_SENDER implementation over SMTP. Sends from EMAIL_FROM (e.g. the official
 * project mailbox "Tammha <support@tammha.site>"). Errors are rethrown with a short,
 * secret-free `code` only.
 */
export class SmtpEmailSender implements EmailSender {
  readonly name = 'smtp';

  constructor(
    private readonly settings: SmtpSettings,
    private readonly transport: SmtpTransport,
  ) {}

  isEnabled(): boolean {
    return true;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    let info: Awaited<ReturnType<SmtpTransport['sendMail']>>;
    try {
      // CID images render inside Gmail and common email clients without needing
      // the user to load an image from an external URL.
      const needsBanner =
        message.html?.includes(`cid:${TAMMHA_EMAIL_BANNER_CID}`) ?? false;
      const bannerPath = join(
        process.cwd(),
        'assets',
        'email',
        'tammha-banner.png',
      );
      if (needsBanner && !existsSync(bannerPath)) {
        throw Object.assign(new Error('Tammha email banner missing'), {
          code: 'EMAIL_ASSET_MISSING',
        });
      }
      info = await this.transport.sendMail({
        from: message.from ?? this.settings.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html && { html: message.html }),
        ...(needsBanner && {
          attachments: [
            {
              filename: 'tammha-banner.png',
              path: bannerPath,
              cid: TAMMHA_EMAIL_BANNER_CID,
              contentType: 'image/png',
              contentDisposition: 'inline',
            },
          ],
        }),
        ...((message.replyTo ?? this.settings.replyTo) && {
          replyTo: (message.replyTo ?? this.settings.replyTo)!,
        }),
        headers: {
          // automated message: no auto-replies
          'Auto-Submitted': 'auto-generated',
          ...(message.tags?.length && {
            'X-Tammha-Category': message.tags.join(','),
          }),
        },
      });
    } catch (error) {
      if ((error as { code?: string })?.code === 'EMAIL_ASSET_MISSING') {
        throw Object.assign(new Error('e-mail not sent'), {
          code: 'EMAIL_ASSET_MISSING',
        });
      }
      throw Object.assign(new Error('e-mail not sent'), {
        code: smtpErrorCode(error),
      });
    }
    if (info.rejected?.length && !info.accepted?.length) {
      throw Object.assign(new Error('e-mail not sent'), {
        code: 'EMAIL_RECIPIENT_REJECTED',
      });
    }
    return {
      provider: 'smtp',
      messageId: info.messageId ?? null,
      acceptedAt: new Date(),
    };
  }

  /** Connection + login check (npm run email:smoke). */
  async verify(): Promise<void> {
    try {
      await this.transport.verify?.();
    } catch (error) {
      throw Object.assign(new Error('SMTP check failed'), {
        code: smtpErrorCode(error),
      });
    }
  }

  close() {
    this.transport.close?.();
  }
}
