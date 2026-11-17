import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { TAMMHA_EMAIL_BANNER_CID } from '@/common/email/email-layout';
import { EmailMessage, EmailSendResult, EmailSender } from './email.sender';

export interface ResendSettings {
  apiKey: string;
  from: string;
  replyTo: string | null;
  timeoutMs: number;
}

/** HTTPS transport avoids outbound SMTP restrictions on Render Free. */
export class ResendEmailSender implements EmailSender {
  readonly name = 'resend';

  constructor(
    private readonly settings: ResendSettings,
    private readonly request: typeof fetch = fetch,
  ) {}

  isEnabled(): boolean {
    return true;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const payload: Record<string, unknown> = {
      from: message.from ?? this.settings.from,
      to: Array.isArray(message.to) ? message.to : [message.to],
      subject: message.subject,
      text: message.text,
      ...(message.html && { html: message.html }),
      ...((message.replyTo ?? this.settings.replyTo) && {
        reply_to: message.replyTo ?? this.settings.replyTo,
      }),
    };

    const needsBanner =
      message.html?.includes(`cid:${TAMMHA_EMAIL_BANNER_CID}`) ?? false;
    if (needsBanner) {
      const path = join(process.cwd(), 'assets', 'email', 'tammha-banner.png');
      if (!existsSync(path)) {
        throw Object.assign(new Error('e-mail not sent'), {
          code: 'EMAIL_ASSET_MISSING',
        });
      }
      payload.attachments = [
        {
          filename: 'tammha-banner.png',
          content: readFileSync(path).toString('base64'),
          content_type: 'image/png',
          content_id: TAMMHA_EMAIL_BANNER_CID,
        },
      ];
    }

    // Only add valid, nonempty tags. Resend uses name/value pairs, not SMTP headers.
    const category = message.tags?.[0]?.replace(/[^A-Za-z0-9_-]/g, '_');
    if (category) {
      payload.tags = [{ name: 'category', value: category.slice(0, 128) }];
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.settings.timeoutMs,
    );
    try {
      const response = await this.request('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.settings.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        const code =
          response.status === 401 || response.status === 403
            ? 'EMAIL_AUTH_FAILED'
            : response.status === 429 || response.status >= 500
              ? 'EMAIL_TEMPORARY_FAILURE'
              : response.status >= 400 && response.status < 500
                ? 'EMAIL_MESSAGE_REJECTED'
                : 'EMAIL_SEND_FAILED';
        throw Object.assign(new Error('e-mail not sent'), { code });
      }
      const data: unknown = await response.json();
      const messageId =
        typeof data === 'object' &&
        data !== null &&
        'id' in data &&
        typeof data.id === 'string'
          ? data.id
          : null;
      if (!messageId) {
        throw Object.assign(new Error('e-mail not sent'), {
          code: 'EMAIL_SEND_FAILED',
        });
      }
      return { provider: 'resend', messageId, acceptedAt: new Date() };
    } catch (error) {
      const coded = error as { code?: unknown; name?: unknown };
      if (typeof coded.code === 'string' && coded.code.startsWith('EMAIL_')) {
        throw error;
      }
      throw Object.assign(new Error('e-mail not sent'), {
        code:
          coded.name === 'AbortError'
            ? 'EMAIL_TIMEOUT'
            : 'EMAIL_CONNECTION_FAILED',
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
