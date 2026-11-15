import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EMAIL_SENDER, EmailSender } from '@/integrations/email/email.sender';
import { parseCorsOrigins } from '@/config/security.config';
import {
  EmailLanguage,
  emailLanguage,
  renderTammhaMail,
} from '@/common/email/email-layout';

export type EmailDeliveryState = 'ENABLED' | 'NOT_CONFIGURED';

/** Retry delays for a failed account e-mail (after the first, awaited attempt). */
const RETRY_DELAYS_MS = [10_000, 60_000];

/**
 * Account e-mails (verification, university e-mail verification, password reset)
 * through the EMAIL_SENDER port (SMTP when EMAIL_ENABLED=true).
 *
 * Links point at the frontend's static pages: <FRONTEND_ORIGIN>/verify-email.html?token=...,
 * /verify-university-email.html?token=..., /reset-password.html?token=... and
 * /activate-account.html?token=... (first CORS origin / localhost in development). The
 * frontend is plain HTML, so the page file names are part of the link.
 *
 * Why not the email_deliveries outbox: these links contain live single-use tokens, and
 * the database only keeps their SHA-256 digests. Queuing the e-mail body would store the
 * raw token. Instead they are sent after the request's database work is done (never
 * inside a transaction); a failure never fails the request, is logged with a short code
 * and retried twice in the background, and the user can always ask for a new link.
 *
 * Without a provider nothing is sent; for local development only DEV_LOG_EMAIL_LINKS=true
 * writes the link to the server log (refused when NODE_ENV=production). Delivery problems
 * are never reported to the caller in detail (that would reveal whether an account exists).
 */
@Injectable()
export class AccountEmailService implements OnApplicationShutdown {
  private readonly logger = new Logger('AccountEmail');
  private readonly frontendUrl: string;
  private readonly devLogLinks: boolean;
  private readonly retries = new Set<Promise<void>>();
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    config: ConfigService,
    @Optional() @Inject(EMAIL_SENDER) private readonly sender?: EmailSender,
  ) {
    const origins = parseCorsOrigins({
      FRONTEND_ORIGIN: config.get('FRONTEND_ORIGIN'),
      CORS_ORIGINS: config.get('CORS_ORIGINS'),
    });
    this.frontendUrl = origins[0] ?? 'http://localhost:5173';
    this.devLogLinks =
      config.get<string>('NODE_ENV') !== 'production' &&
      /^(true|1|yes)$/i.test(config.get<string>('DEV_LOG_EMAIL_LINKS') ?? '');
  }

  get deliveryState(): EmailDeliveryState {
    return this.sender?.isEnabled() ? 'ENABLED' : 'NOT_CONFIGURED';
  }

  verificationLink(token: string) {
    return `${this.frontendUrl}/verify-email.html?token=${encodeURIComponent(token)}`;
  }

  universityEmailLink(token: string) {
    return `${this.frontendUrl}/verify-university-email.html?token=${encodeURIComponent(token)}`;
  }

  resetLink(token: string) {
    return `${this.frontendUrl}/reset-password.html?token=${encodeURIComponent(token)}`;
  }

  activationLink(token: string) {
    return `${this.frontendUrl}/activate-account.html?token=${encodeURIComponent(token)}`;
  }

  /** Account email templates are never persisted in the notification outbox (token safety). */
  private accountTemplate(
    purpose: 'activation' | 'verify' | 'university' | 'reset',
    name: string | null,
    tokenLink: string,
    language: EmailLanguage,
  ) {
    const copy = {
      activation: {
        ar: {
          subject: 'تممها | تفعيل حسابك كمشرف',
          body: 'تم إنشاء حساب مشرف لك في منصة تممها. لاستكمال التفعيل، يرجى تعيين كلمة مرور خاصة بحسابك. رابط التفعيل صالح لمدة 7 أيام ويُستخدم مرة واحدة فقط. إذا لم تتوقع هذه الرسالة، يمكنك تجاهلها.',
          button: 'تفعيل الحساب',
        },
        en: {
          subject: 'Tammha | Activate Your Supervisor Account',
          body: 'A supervisor account has been created for you on Tammha. Please set your account password to complete activation. This link is valid for 7 days and can only be used once. If you did not expect this email, you may ignore it.',
          button: 'Activate Account',
        },
      },
      verify: {
        ar: {
          subject: 'تممها | تأكيد بريدك الإلكتروني',
          body: 'شكرًا لتسجيلك في تممها. يرجى تأكيد بريدك الإلكتروني لاستكمال إعداد حسابك. رابط التأكيد صالح لمدة 24 ساعة. إذا لم تنشئ حسابًا في تممها، يمكنك تجاهل هذه الرسالة.',
          button: 'تأكيد البريد الإلكتروني',
        },
        en: {
          subject: 'Tammha | Verify Your Email Address',
          body: 'Thank you for registering with Tammha. Please verify your email address to complete your account setup. This link is valid for 24 hours. If you did not create an account, you may ignore this email.',
          button: 'Verify Email Address',
        },
      },
      university: {
        ar: {
          subject: 'تممها | تأكيد بريدك الجامعي',
          body: 'لإكمال التحقق من هويتك الجامعية، يرجى تأكيد أن هذا البريد الجامعي يعود إليك. رابط التأكيد صالح لمدة 24 ساعة. إذا لم تطلب إضافة هذا البريد إلى حساب في تممها، يمكنك تجاهل الرسالة.',
          button: 'تأكيد البريد الجامعي',
        },
        en: {
          subject: 'Tammha | Verify Your University Email',
          body: 'To complete your university identity verification, please confirm that this university email address belongs to you. This link is valid for 24 hours. If you did not request this, you may ignore the email.',
          button: 'Verify University Email',
        },
      },
      reset: {
        ar: {
          subject: 'تممها | إعادة تعيين كلمة المرور',
          body: 'تلقينا طلبًا لإعادة تعيين كلمة مرور حسابك في تممها. يمكنك اختيار كلمة مرور جديدة من خلال الزر أدناه. الرابط صالح لمدة 30 دقيقة ويُستخدم مرة واحدة فقط. إذا لم تطلب ذلك، يمكنك تجاهل الرسالة وستبقى كلمة مرورك الحالية كما هي.',
          button: 'إعادة تعيين كلمة المرور',
        },
        en: {
          subject: 'Tammha | Reset Your Password',
          body: 'We received a request to reset your Tammha password. Use the button below to create a new password. This link is valid for 30 minutes and can only be used once. If you did not request this, you can safely ignore this email; your password will remain unchanged.',
          button: 'Reset Password',
        },
      },
    }[purpose][language];
    return renderTammhaMail({
      language,
      recipientName: name,
      subject: copy.subject,
      body: copy.body,
      buttonLabel: copy.button,
      actionUrl: tokenLink,
    });
  }

  /** SUPERVISOR account created by an ADMIN: choose the first password. */
  async sendAccountActivation(
    to: string,
    name: string | null,
    token: string,
    preferredLanguage: string = 'ar',
  ) {
    const link = this.activationLink(token);
    await this.deliver(to, 'account activation', {
      ...this.accountTemplate(
        'activation',
        name,
        link,
        emailLanguage(preferredLanguage),
      ),
      link,
    });
  }

  async sendVerification(
    to: string,
    name: string | null,
    token: string,
    preferredLanguage: string = 'ar',
  ) {
    const link = this.verificationLink(token);
    await this.deliver(to, 'verification', {
      ...this.accountTemplate(
        'verify',
        name,
        link,
        emailLanguage(preferredLanguage),
      ),
      link,
    });
  }

  async sendUniversityEmailVerification(
    to: string,
    name: string | null,
    token: string,
    preferredLanguage: string = 'ar',
  ) {
    const link = this.universityEmailLink(token);
    await this.deliver(to, 'university e-mail verification', {
      ...this.accountTemplate(
        'university',
        name,
        link,
        emailLanguage(preferredLanguage),
      ),
      link,
    });
  }

  async sendPasswordReset(
    to: string,
    name: string | null,
    token: string,
    preferredLanguage: string = 'ar',
  ) {
    const link = this.resetLink(token);
    await this.deliver(to, 'password reset', {
      ...this.accountTemplate(
        'reset',
        name,
        link,
        emailLanguage(preferredLanguage),
      ),
      link,
    });
  }

  private async deliver(
    to: string,
    purpose: string,
    mail: { subject: string; text: string; html: string; link: string },
  ) {
    if (this.sender?.isEnabled()) {
      const message = {
        to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        tags: [purpose.replace(/\s+/g, '-')],
      };
      if (await this.attempt(message, purpose, 1)) return;
      // retried in the background; the request has already succeeded
      const retry = this.retryLater(message, purpose).finally(() =>
        this.retries.delete(retry),
      );
      this.retries.add(retry);
      return;
    }
    if (this.devLogLinks) {
      // development only (refused in production by the env validation)
      this.logger.log(`[DEV_LOG_EMAIL_LINKS] ${purpose} link: ${mail.link}`);
    }
  }

  private async attempt(
    message: {
      to: string;
      subject: string;
      text: string;
      html: string;
      tags: string[];
    },
    purpose: string,
    attempt: number,
  ): Promise<boolean> {
    try {
      await this.sender!.send(message);
      return true;
    } catch (error) {
      const e = error as { code?: string; name?: string };
      this.logger.warn(
        `${purpose} e-mail attempt ${attempt} not sent (${e?.code ?? e?.name ?? 'error'})`,
      );
      return false;
    }
  }

  private async retryLater(
    message: {
      to: string;
      subject: string;
      text: string;
      html: string;
      tags: string[];
    },
    purpose: string,
  ) {
    for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          this.timers.delete(t);
          resolve();
        }, RETRY_DELAYS_MS[i]);
        t.unref?.();
        this.timers.add(t);
      });
      if (await this.attempt(message, purpose, i + 2)) return;
    }
    this.logger.warn(
      `${purpose} e-mail failed after ${RETRY_DELAYS_MS.length + 1} attempts`,
    );
  }

  /** Background retries still waiting (tests). */
  get pendingRetries(): number {
    return this.retries.size;
  }

  onApplicationShutdown() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
