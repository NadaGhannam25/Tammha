import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailDeliveryStatus, Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { EMAIL_SENDER, EmailSender } from '@/integrations/email/email.sender';
import { PERMANENT_EMAIL_ERRORS } from '@/integrations/email/smtp-email.sender';
import { readNotificationSettings } from '../notifications.config';
import { parseCorsOrigins } from '@/config/security.config';
import { emailLanguage } from '@/common/email/email-layout';
import { renderNotificationEmail } from './email-templates';
import type { NotificationInput } from '../notification.types';

type Db = PrismaService | Prisma.TransactionClient;

/** A row stuck in SENDING (process crashed mid-send) is retried after this. */
const STALE_SENDING_MS = 10 * 60 * 1000;
const BATCH_SIZE = 25;
/** Retry delays after attempt 1, 2, 3, ... */
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
/** Errors that will not go away by retrying. */
const PERMANENT_ERRORS = new Set<string>([
  'INTEGRATION_DISABLED',
  'INTEGRATION_NOT_IMPLEMENTED',
  'RECIPIENT_UNAVAILABLE',
  ...PERMANENT_EMAIL_ERRORS,
]);

export interface DispatchResult {
  sent: number;
  failed: number;
  retrying: number;
}

/**
 * Email outbox (provider-neutral).
 *
 * enqueue():   writes EmailDelivery rows in the caller's transaction. Unique
 *              (userId, dedupeKey) => the same event is never emailed twice to a user.
 * dispatch():  sends PENDING rows through the EMAIL_SENDER port (P10), one at a time,
 *              with a compare-and-set claim so two processes never send the same row.
 *              Failures are retried with backoff, then marked FAILED. The in-app
 *              notification is never touched.
 *
 * Recipient: always the e-mail address of the user's Tammha account (read at send time).
 * Nothing is queued or sent while email delivery is disabled (EMAIL_ENABLED=false).
 * Logs contain ids and short error codes only: no addresses, bodies or secrets.
 */
@Injectable()
export class EmailOutboxService implements OnModuleDestroy {
  private readonly logger = new Logger('EmailOutbox');
  private readonly maxAttempts: number;
  private readonly frontendUrl: string;
  private flushTimer: NodeJS.Timeout | null = null;
  private dispatching: Promise<DispatchResult> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
    @Optional() @Inject(EMAIL_SENDER) private readonly sender?: EmailSender,
  ) {
    const origins = parseCorsOrigins({
      FRONTEND_ORIGIN: config.get('FRONTEND_ORIGIN'),
      CORS_ORIGINS: config.get('CORS_ORIGINS'),
    });
    this.frontendUrl = origins[0] ?? 'http://localhost:5173';
    this.maxAttempts = readNotificationSettings({
      EMAIL_MAX_ATTEMPTS: config.get<string>('EMAIL_MAX_ATTEMPTS'),
    }).settings.emailMaxAttempts;
  }

  isEnabled(): boolean {
    return !!this.sender?.isEnabled();
  }

  async enqueue(
    emails: {
      notification: { id: string; userId: string; dedupeKey: string | null };
      input: NotificationInput;
    }[],
    db: Db,
  ): Promise<number> {
    if (emails.length === 0 || !this.isEnabled()) return 0;
    // Resolve each recipient's persisted language INSIDE the caller's transaction.
    // The event description is not translated using an external service.
    const users = await db.user.findMany({
      where: {
        id: { in: [...new Set(emails.map((e) => e.notification.userId))] },
      },
      select: { id: true, firstName: true, preferredLanguage: true },
    });
    const preferences = new Map(users.map((u) => [u.id, u]));
    const { count } = await db.emailDelivery.createMany({
      data: emails.map(({ notification, input }) => {
        const user = preferences.get(notification.userId);
        const content = renderNotificationEmail({
          ...input,
          language: emailLanguage(user?.preferredLanguage),
          recipientName: user?.firstName,
          frontendUrl: this.frontendUrl,
        });
        return {
          userId: notification.userId,
          notificationId: notification.id,
          dedupeKey:
            notification.dedupeKey ?? `notification:${notification.id}`,
          type: input.type,
          subject: content.subject,
          textBody: content.text,
          htmlBody: content.html,
        };
      }),
      skipDuplicates: true,
    });
    if (count > 0) this.requestFlush();
    return count;
  }

  /** Send soon (after the caller's transaction has committed). */
  requestFlush(delayMs = 1000) {
    if (this.flushTimer || !this.isEnabled()) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.dispatch().catch((e) =>
        this.logger.warn(`dispatch failed: ${errorCode(e)}`),
      );
    }, delayMs);
    this.flushTimer.unref?.();
  }

  /** Sends due emails. Concurrent calls in one process share the same run. */
  dispatch(now = new Date()): Promise<DispatchResult> {
    if (!this.dispatching) {
      this.dispatching = this.runDispatch(now).finally(() => {
        this.dispatching = null;
      });
    }
    return this.dispatching;
  }

  private async runDispatch(now: Date): Promise<DispatchResult> {
    const result: DispatchResult = { sent: 0, failed: 0, retrying: 0 };
    if (!this.isEnabled()) return result;

    await this.prisma.emailDelivery.updateMany({
      where: {
        status: EmailDeliveryStatus.SENDING,
        updatedAt: { lt: new Date(now.getTime() - STALE_SENDING_MS) },
      },
      data: { status: EmailDeliveryStatus.PENDING },
    });

    const due = await this.prisma.emailDelivery.findMany({
      where: {
        status: EmailDeliveryStatus.PENDING,
        nextAttemptAt: { lte: now },
      },
      select: {
        id: true,
        attempts: true,
        type: true,
        subject: true,
        textBody: true,
        htmlBody: true,
        user: { select: { email: true, isActive: true } },
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
      take: BATCH_SIZE,
    });

    for (const row of due) {
      const attempt = row.attempts + 1;
      // Claim: only one process moves PENDING -> SENDING for this attempt.
      const { count } = await this.prisma.emailDelivery.updateMany({
        where: {
          id: row.id,
          status: EmailDeliveryStatus.PENDING,
          attempts: row.attempts,
        },
        data: { status: EmailDeliveryStatus.SENDING, attempts: attempt },
      });
      if (count === 0) continue;

      try {
        if (!row.user?.isActive || !row.user.email) {
          throw Object.assign(new Error('recipient unavailable'), {
            code: 'RECIPIENT_UNAVAILABLE',
          });
        }
        const sent = await this.sender!.send({
          to: row.user.email,
          subject: row.subject,
          text: row.textBody,
          html: row.htmlBody ?? undefined,
          tags: [row.type],
        });
        await this.prisma.emailDelivery.update({
          where: { id: row.id },
          data: {
            status: EmailDeliveryStatus.SENT,
            sentAt: sent.acceptedAt ?? new Date(),
            provider: sent.provider,
            providerMessageId: sent.messageId,
            lastError: null,
          },
        });
        result.sent++;
      } catch (error) {
        const code = errorCode(error);
        const final = PERMANENT_ERRORS.has(code) || attempt >= this.maxAttempts;
        await this.prisma.emailDelivery.update({
          where: { id: row.id },
          data: final
            ? { status: EmailDeliveryStatus.FAILED, lastError: code }
            : {
                status: EmailDeliveryStatus.PENDING,
                lastError: code,
                nextAttemptAt: new Date(
                  now.getTime() +
                    BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)],
                ),
              },
        });
        if (final) result.failed++;
        else result.retrying++;
        this.logger.warn(
          `email ${row.id} attempt ${attempt} ${final ? 'failed' : 'will retry'}: ${code}`,
        );
      }
    }
    return result;
  }

  onModuleDestroy() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }
}

/** Short, secret-free error code (never the provider's message text). */
export function errorCode(error: unknown): string {
  const e = error as {
    code?: unknown;
    response?: { code?: unknown };
    status?: unknown;
  };
  const raw =
    e?.response?.code ?? e?.code ?? (e?.status ? `HTTP_${e.status}` : null);
  const code =
    typeof raw === 'string' || typeof raw === 'number'
      ? String(raw)
      : 'SEND_FAILED';
  return code.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'SEND_FAILED';
}
