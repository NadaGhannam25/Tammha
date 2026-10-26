/**
 * Port for e-mail delivery used by the P11 outbox (email_deliveries + dispatcher).
 * Notification code builds the message; an adapter would only deliver it.
 * No e-mail provider adapter is part of this backend, so the injected sender is
 * always disabled (EMAIL_ENABLED=false); tests inject a fake sender.
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
