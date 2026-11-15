import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuthTokenType, User, UserRole } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuthUser } from '@common/types/auth-user.type';
import { emailEquals } from '@common/utils/email.util';
import { isUniqueConstraintError } from '@common/utils/prisma-errors.util';
import {
  emailDomainAllowed,
  emailMatchesConfiguredDomain,
} from '@common/identity/university-email';
import {
  identityMissingAtInput,
  UniversityIdentityState,
  universityIdentityOf,
} from '@common/identity/university-identity';
import { AuthTokensService } from './auth-tokens.service';
import {
  AccountEmailService,
  EmailDeliveryState,
} from './account-email.service';

/** Same cooldown as the account verification e-mail. */
const RESEND_COOLDOWN_MS = 60 * 1000;

const taken = () =>
  new ConflictException({
    code: 'UNIVERSITY_EMAIL_TAKEN',
    message: 'This university e-mail is already used by another account',
  });
const domainMismatch = (domains: string[]) =>
  new BadRequestException({
    code: 'UNIVERSITY_EMAIL_DOMAIN_MISMATCH',
    message: "This e-mail does not belong to your university's e-mail domains",
    details: { allowedDomains: domains },
  });
const notAllowed = () =>
  new BadRequestException({
    code: 'UNIVERSITY_EMAIL_NOT_ALLOWED',
    message: 'Only STUDENT accounts have a university e-mail',
  });

export interface UniversityEmailRequestResult {
  status: 'VERIFIED' | 'PENDING_VERIFICATION';
  message: string;
  emailDelivery: EmailDeliveryState;
  universityIdentity: UniversityIdentityState;
}

/**
 * University identity of students (student number OR verified university e-mail).
 *
 * - The account e-mail stays the address for sign-in, verification, password recovery
 *   and notifications. The university e-mail is an identifier, and only a VERIFIED one
 *   counts (it is stored in users.universityEmail only after its link was used; a
 *   requested address waits in pendingUniversityEmail).
 * - When the university e-mail IS the account e-mail, verifying either one verifies both:
 *   the student never types or confirms a second address.
 * - Domains: validated against universities.emailDomains when the operator configured
 *   them; otherwise any well-formed address is accepted (it must still be verified).
 */
@Injectable()
export class UniversityIdentityService {
  private readonly logger = new Logger('UniversityIdentity');

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AuthTokensService,
    private readonly accountEmail: AccountEmailService,
  ) {}

  /**
   * Registration of a STUDENT: returns the university e-mail to verify (or null).
   * 400 UNIVERSITY_IDENTITY_REQUIRED when neither a student number nor a university
   * e-mail is given (or detectable from the account e-mail's domain).
   */
  async resolveForRegistration(input: {
    accountEmail: string;
    studentNumber: string | null;
    universityEmail?: string;
    accountEmailIsUniversityEmail?: boolean;
    emailDomains: string[];
    /** new registrations: a university e-mail is required (400 UNIVERSITY_EMAIL_REQUIRED) */
    requireUniversityEmail?: boolean;
  }): Promise<string | null> {
    let universityEmail = input.universityEmail ?? null;
    if (input.accountEmailIsUniversityEmail) {
      if (universityEmail && universityEmail !== input.accountEmail) {
        throw new BadRequestException({
          code: 'UNIVERSITY_EMAIL_MISMATCH',
          message:
            'accountEmailIsUniversityEmail is true but universityEmail is a different address',
        });
      }
      universityEmail = input.accountEmail;
    }
    // account e-mail on a configured university domain = the university e-mail
    if (
      !universityEmail &&
      emailMatchesConfiguredDomain(input.accountEmail, input.emailDomains)
    ) {
      universityEmail = input.accountEmail;
    }
    if (!universityEmail && input.requireUniversityEmail) {
      throw new BadRequestException({
        code: 'UNIVERSITY_EMAIL_REQUIRED',
        message:
          'A university e-mail is required: register with your university e-mail address (or add it as universityEmail).',
        details: { allowedDomains: input.emailDomains },
      });
    }
    if (!universityEmail && !input.studentNumber)
      throw identityMissingAtInput();
    if (universityEmail) {
      if (!emailDomainAllowed(universityEmail, input.emailDomains)) {
        throw domainMismatch(input.emailDomains);
      }
      await this.assertAvailable(universityEmail, null, input.accountEmail);
    }
    return universityEmail;
  }

  /** After registration: the university-e-mail link, when it is not the account e-mail. */
  async sendAfterRegistration(user: User) {
    const pending = user.pendingUniversityEmail;
    if (pending && pending !== user.email.toLowerCase()) {
      await this.sendLink(user, pending);
    }
  }

  /** Authenticated STUDENT: add or replace the university e-mail (verification link). */
  async request(
    user: AuthUser,
    universityEmail: string,
  ): Promise<UniversityEmailRequestResult> {
    if (user.role !== UserRole.STUDENT) throw notAllowed();
    if (
      user.universityEmail === universityEmail &&
      user.universityEmailVerifiedAt
    ) {
      throw new ConflictException({
        code: 'UNIVERSITY_EMAIL_ALREADY_VERIFIED',
        message: 'This university e-mail is already verified on your account',
      });
    }
    const domains = await this.domainsOf(user.universityId);
    if (!emailDomainAllowed(universityEmail, domains)) {
      throw domainMismatch(domains);
    }
    await this.assertAvailable(universityEmail, user.id, user.email);

    // the verified account e-mail already proves this mailbox
    if (universityEmail === user.email.toLowerCase() && user.emailVerifiedAt) {
      const row = await this.markVerified(user.id, universityEmail, false);
      return {
        status: 'VERIFIED',
        message: 'Your university e-mail is verified.',
        emailDelivery: this.accountEmail.deliveryState,
        universityIdentity: universityIdentityOf(row),
      };
    }

    const last = await this.tokens.lastIssuedAt(
      user.id,
      AuthTokenType.UNIVERSITY_EMAIL_VERIFICATION,
    );
    const waitMs = last ? last.getTime() + RESEND_COOLDOWN_MS - Date.now() : 0;
    if (waitMs > 0) {
      throw new HttpException(
        {
          code: 'VERIFICATION_RECENTLY_SENT',
          message:
            'A verification e-mail was just sent. Please wait before asking again.',
          details: { retryAfterSeconds: Math.ceil(waitMs / 1000) },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const row = await this.prisma.user.update({
      where: { id: user.id },
      data: { pendingUniversityEmail: universityEmail },
    });
    await this.sendLink(row, universityEmail);
    return {
      status: 'PENDING_VERIFICATION',
      message: 'A verification link has been sent to your university e-mail.',
      emailDelivery: this.accountEmail.deliveryState,
      universityIdentity: universityIdentityOf(row),
    };
  }

  /** Public: the link sent to the university e-mail. */
  async verify(token: string) {
    const invalid = () =>
      new BadRequestException({
        code: 'VERIFICATION_TOKEN_INVALID',
        message: 'This link is invalid or has expired. Request a new one.',
      });
    const { userId, email } = await this.tokens.consumeRecord(
      token,
      AuthTokenType.UNIVERSITY_EMAIL_VERIFICATION,
    );
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    // a newer request replaced this address, or the account changed
    if (
      !email ||
      !user ||
      !user.isActive ||
      user.role !== UserRole.STUDENT ||
      user.pendingUniversityEmail !== email
    ) {
      throw invalid();
    }
    const domains = await this.domainsOf(user.universityId);
    if (!emailDomainAllowed(email, domains)) throw domainMismatch(domains);
    await this.assertAvailable(email, user.id, user.email);
    // the same mailbox is also the account e-mail: verify both
    const alsoAccount =
      email === user.email.toLowerCase() && !user.emailVerifiedAt;
    const row = await this.markVerified(user.id, email, alsoAccount);
    return {
      message: 'Your university e-mail is verified.',
      universityEmailVerified: true,
      universityIdentity: universityIdentityOf(row),
    };
  }

  /**
   * Called after the ACCOUNT e-mail was verified (verification link or password reset):
   * when the pending university e-mail is that same address, it is verified too.
   * Best effort: a conflict leaves it pending (never blocks the account verification).
   */
  async promoteAccountEmail(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const pending = user?.pendingUniversityEmail;
    if (!user || !pending || !user.emailVerifiedAt) return;
    if (pending !== user.email.toLowerCase()) return;
    const domains = await this.domainsOf(user.universityId);
    if (!emailDomainAllowed(pending, domains)) return;
    try {
      await this.assertAvailable(pending, user.id, user.email);
      await this.markVerified(user.id, pending, false);
    } catch (error) {
      this.logger.warn(
        `university e-mail of user ${userId} left pending: ${(error as { response?: { code?: string } })?.response?.code ?? (error as Error)?.name}`,
      );
    }
  }

  // ==========================================================
  // Internals
  // ==========================================================

  private async sendLink(user: User, address: string) {
    const token = await this.tokens.issue(
      user.id,
      AuthTokenType.UNIVERSITY_EMAIL_VERIFICATION,
      this.prisma,
      new Date(),
      address,
    );
    await this.accountEmail.sendUniversityEmailVerification(
      address,
      user.firstName,
      token,
      user.preferredLanguage,
    );
  }

  private async markVerified(
    userId: string,
    email: string,
    alsoAccountEmail: boolean,
  ) {
    const now = new Date();
    try {
      return await this.prisma.user.update({
        where: { id: userId },
        data: {
          universityEmail: email,
          universityEmailVerifiedAt: now,
          pendingUniversityEmail: null,
          ...(alsoAccountEmail && { emailVerifiedAt: now }),
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) throw taken();
      throw error;
    }
  }

  /**
   * 409 UNIVERSITY_EMAIL_TAKEN when another account already has this address as its
   * verified university e-mail or as its account e-mail.
   */
  private async assertAvailable(
    email: string,
    userId: string | null,
    ownAccountEmail: string,
  ) {
    const other = await this.prisma.user.findUnique({
      where: { universityEmail: email },
      select: { id: true },
    });
    if (other && other.id !== userId) throw taken();
    if (email === ownAccountEmail.toLowerCase()) return;
    const account = await this.prisma.user.findFirst({
      where: emailEquals(email),
      select: { id: true },
    });
    if (account && account.id !== userId) throw taken();
  }

  private async domainsOf(universityId: string | null): Promise<string[]> {
    if (!universityId) {
      throw new NotFoundException({
        code: 'UNIVERSITY_REQUIRED',
        message: 'Your account has no university',
      });
    }
    const university = await this.prisma.university.findUnique({
      where: { id: universityId },
      select: { emailDomains: true },
    });
    return university?.emailDomains ?? [];
  }
}
