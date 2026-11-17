/**
 * Port for e-mail delivery. Implementation: SmtpEmailSender (EMAIL_ENABLED=true),
 * otherwise a disabled sender. Notification e-mails go through the P11 outbox
 * (email_deliveries + dispatcher); account e-mails through AccountEmailService.
 * Tests inject a fake sender or a fake SMTP transport.
 */
export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

export interface EmailMessage {
  to: string | string[];
  subject: string;
  /** Plain-text body (always sent) */
  text: string;
  /** Optional HTML body */
  html?: string;
  replyTo?: string;
  /** Sender address for this message (default: the configured EMAIL_FROM) */
  from?: string;
  /** Free-form tags for provider analytics, e.g. ['feedback'] */
  tags?: string[];
}

export interface EmailSendResult {
  provider: string;
  /** Provider message id when available */
  messageId: string | null;
  acceptedAt: Date;
}

export interface EmailSender {
  readonly name: string;
  isEnabled(): boolean;
  send(message: EmailMessage): Promise<EmailSendResult>;
}
