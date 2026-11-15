import {
  EmailMessage,
  EmailSendResult,
  EmailSender,
} from '@/integrations/email/email.sender';

/**
 * TEST-ONLY EmailSender: records messages instead of sending them.
 * `failNext(code, times)` makes the next sends throw an error with that code.
 */
export class FakeEmailSender implements EmailSender {
  readonly name = 'fake-email';
  enabled = true;
  readonly sent: EmailMessage[] = [];
  private failures: string[] = [];

  isEnabled() {
    return this.enabled;
  }

  failNext(code: string, times = 1) {
    for (let i = 0; i < times; i++) this.failures.push(code);
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const failure = this.failures.shift();
    if (failure) {
      throw Object.assign(
        new Error(`provider said no (secret=FAKE-PROVIDER-SECRET)`),
        { code: failure },
      );
    }
    this.sent.push(message);
    return {
      provider: 'fake-email',
      messageId: `fake-${this.sent.length}`,
      acceptedAt: new Date(),
    };
  }

  reset() {
    this.sent.length = 0;
    this.failures = [];
    this.enabled = true;
  }
}
