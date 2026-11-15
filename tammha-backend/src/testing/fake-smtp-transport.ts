import { SmtpTransport } from '@/integrations/email/smtp-email.sender';

type SentMail = Parameters<SmtpTransport['sendMail']>[0];

/**
 * TEST-ONLY SMTP connection: stands in for nodemailer behind the real SmtpEmailSender,
 * so the whole delivery path (outbox -> EMAIL_SENDER -> SMTP) runs without a network.
 * `failNext(error, times)` makes the next sends throw like nodemailer does.
 */
export class FakeSmtpTransport implements SmtpTransport {
  readonly sent: SentMail[] = [];
  private failures: unknown[] = [];

  failNext(
    error: { code?: string; responseCode?: number; message?: string },
    times = 1,
  ) {
    for (let i = 0; i < times; i++) {
      this.failures.push(
        Object.assign(
          new Error(error.message ?? 'smtp failure (password=SMTP-SECRET)'),
          error,
        ),
      );
    }
  }

  async sendMail(mail: SentMail) {
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.sent.push(mail);
    return {
      messageId: `<fake-${this.sent.length}@tammha.site>`,
      accepted: Array.isArray(mail.to) ? mail.to : [mail.to],
      rejected: [],
    };
  }

  async verify() {
    return true;
  }

  to(address: string) {
    return this.sent.filter((m) =>
      (Array.isArray(m.to) ? m.to : [m.to]).includes(address),
    );
  }

  reset() {
    this.sent.length = 0;
    this.failures = [];
  }
}
