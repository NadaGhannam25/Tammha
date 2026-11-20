import {
  ForbiddenException,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { AuthTokenType, User, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '@/prisma/prisma.service';
import { isUniqueConstraintError } from '@common/utils/prisma-errors.util';
import { UsersService } from '@modules/users/users.service';
import { toSafeUser } from '@modules/users/user.mapper';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AuthTokensDto } from './dto/auth-response.dto';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { AuthTokensService } from './auth-tokens.service';
import { AccountEmailService } from './account-email.service';
import { UniversityIdentityService } from './university-identity.service';
import { readEmailVerificationRequired } from './email-verification.config';
import { emailDomainAllowed } from '@common/identity/university-email';
import {
  customUniversityCode,
  findCatalogUniversity,
  normalizeUniversityName,
} from '@modules/universities/saudi-universities';

/** Minimum time between two verification e-mails for one user. */
const RESEND_COOLDOWN_MS = 60 * 1000;
/** P17: a verification code is valid for 10 minutes. */
export const VERIFICATION_CODE_TTL_MS = 10 * 60 * 1000;
/** P17: at most this many verification codes per user per hour. */
export const VERIFICATION_CODES_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;
/** Same answer for an unknown e-mail, a wrong, used or expired code (no account enumeration). */
const codeInvalid = () =>
  new BadRequestException({
    code: 'VERIFICATION_CODE_INVALID',
    message: 'The code is incorrect or has expired. Request a new code.',
  });

const REFRESH_TOKEN_TTL_DAYS = 30;

/**
 * Refresh tokens are 256-bit random values, so a SHA-256 digest stores them
 * safely and lets us find them through the unique index on tokenHash (O(1)).
 */
const activationInvalid = () =>
  new BadRequestException({
    code: 'ACTIVATION_TOKEN_INVALID',
    message:
      'This activation link is invalid or has expired. Ask your university administrator for a new one.',
  });

export function hashRefreshToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly jwtExpiration: JwtSignOptions['expiresIn'];
  /** Compared against when the email is unknown, so login timing does not reveal accounts. */
  private readonly dummyPasswordHash: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly usersService: UsersService,
    configService: ConfigService,
    private readonly authTokens: AuthTokensService,
    private readonly accountEmail: AccountEmailService,
    private readonly universityIdentity: UniversityIdentityService,
  ) {
    this.jwtExpiration = configService.get<string>(
      'JWT_EXPIRATION',
      '1h',
    ) as JwtSignOptions['expiresIn'];
    const rounds = parseInt(
      configService.get<string>('BCRYPT_ROUNDS', '10'),
      10,
    );
    this.dummyPasswordHash = bcrypt.hashSync(
      'tammha-timing-placeholder',
      rounds,
    );
    this.emailVerificationRequired = readEmailVerificationRequired({
      EMAIL_VERIFICATION_REQUIRED: configService.get<string>(
        'EMAIL_VERIFICATION_REQUIRED',
      ),
      EMAIL_ENABLED: configService.get<string>('EMAIL_ENABLED'),
      NODE_ENV: configService.get<string>('NODE_ENV'),
    }).required;
  }

  /** The product flow needs a verified account e-mail (see JwtAuthGuard). */
  readonly emailVerificationRequired: boolean;

  /**
   * Public registration: STUDENT accounts only. A student needs a university student
   * number AND a university e-mail (the account e-mail on the university's domain, or a
   * separate `universityEmail`); full access starts once the university e-mail is
   * verified (JwtAuthGuard). SUPERVISOR accounts are created by an ADMIN
   * (POST /admin/supervisors) and activated through an e-mailed link.
   */
  async register(registerDto: RegisterDto) {
    const { email, password, firstName, lastName } = registerDto;
    const role = registerDto.role ?? UserRole.STUDENT;
    if (role !== UserRole.STUDENT && role !== UserRole.SUPERVISOR) {
      throw new BadRequestException(
        'ADMIN users cannot be created through public registration',
      );
    }
    const isSupervisor = role === UserRole.SUPERVISOR;
    // STUDENT: student number required. SUPERVISOR: no student number at all.
    const studentNumber = isSupervisor
      ? null
      : (registerDto.studentNumber ?? null);
    if (!isSupervisor && !studentNumber) {
      throw new BadRequestException({
        code: 'STUDENT_NUMBER_REQUIRED',
        message: 'Your university student ID (student number) is required',
      });
    }

    const university = await this.resolveRegistrationUniversity(registerDto);

    // SUPERVISOR self-registration: the account e-mail must be a university address of the
    // chosen university (never a personal mailbox). Owning it is proven by the verification
    // link; until then the supervisor is not offered to students (see supervision requests).
    if (isSupervisor && !emailDomainAllowed(email, university.emailDomains)) {
      throw new BadRequestException({
        code: 'SUPERVISOR_UNIVERSITY_EMAIL_REQUIRED',
        message:
          'Academic supervisors register with their university e-mail address of the selected university',
        details: { allowedDomains: university.emailDomains ?? [] },
      });
    }

    if (await this.usersService.findByEmail(email)) {
      throw new ConflictException({
        code: 'EMAIL_ALREADY_REGISTERED',
        message: 'Email already registered',
      });
    }

    // STUDENT: a student number OR a university e-mail (verified afterwards)
    const pendingUniversityEmail =
      role === UserRole.STUDENT && !isSupervisor
        ? await this.universityIdentity.resolveForRegistration({
            accountEmail: email,
            studentNumber,
            universityEmail: registerDto.universityEmail,
            accountEmailIsUniversityEmail:
              registerDto.accountEmailIsUniversityEmail,
            emailDomains: university.emailDomains ?? [],
            requireUniversityEmail: true,
          })
        : null;

    let user: User;
    try {
      user = await this.usersService.create({
        email,
        password,
        firstName,
        lastName,
        role,
        universityId: university.id,
        studentNumber,
        pendingUniversityEmail,
        preferredLanguage: registerDto.preferredLanguage ?? 'ar',
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const target = (error as { meta?: { target?: unknown } }).meta?.target;
        if (String(target).includes('studentNumber')) {
          throw new ConflictException({
            code: 'STUDENT_NUMBER_TAKEN',
            message:
              'This student number is already registered at this university',
          });
        }
        throw new ConflictException({
          code: 'EMAIL_ALREADY_REGISTERED',
          message: 'Email already registered',
        });
      }
      throw error;
    }

    // P16: verification e-mail (best effort; the account works while unverified)
    await this.sendVerificationEmail(user);
    // a separate link for a university e-mail that is not the account e-mail (students)
    if (!isSupervisor)
      await this.universityIdentity.sendAfterRegistration(user);

    const tokens = await this.generateTokens(user.id, user.email, user.role);
    return {
      user: toSafeUser(user),
      tokens,
      emailVerificationRequired: this.emailVerificationRequired,
    };
  }

  /**
   * The university of a new account: a listed university (universityId) or, when it is not
   * listed, the name the user typed (universityName). A typed name that matches a listed
   * university (English or Arabic) uses that row; otherwise one row per normalised name is
   * created (code CUSTOM-…), so everyone who types the same university shares it and the
   * same-university rules keep working. Such a university has no e-mail domains: any
   * non-personal address is accepted and must still be verified.
   */
  private async resolveRegistrationUniversity(dto: RegisterDto) {
    const select = { id: true, isActive: true, emailDomains: true } as const;
    const inactive = () =>
      new BadRequestException(
        'universityId does not match an active university',
      );
    if (dto.universityId) {
      const row = await this.prisma.university.findUnique({
        where: { id: dto.universityId },
        select,
      });
      if (!row || !row.isActive) throw inactive();
      return row;
    }
    const name = normalizeUniversityName(dto.universityName ?? '');
    if (name.length < 3) {
      throw new BadRequestException({
        code: 'UNIVERSITY_REQUIRED',
        message: 'Select your university or type its name',
      });
    }
    const listed = findCatalogUniversity(name);
    if (listed) {
      const row = await this.prisma.university.findUnique({
        where: { code: listed.code },
        select,
      });
      if (row?.isActive) return row;
    }
    const sameName = await this.prisma.university.findUnique({
      where: { name },
      select,
    });
    if (sameName) {
      if (!sameName.isActive) throw inactive();
      return sameName;
    }
    const code = customUniversityCode(name);
    const existing = await this.prisma.university.findUnique({
      where: { code },
      select,
    });
    if (existing) {
      if (!existing.isActive) throw inactive();
      return existing;
    }
    try {
      return await this.prisma.university.create({
        data: { name, code, isActive: true },
        select,
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const row = await this.prisma.university.findUnique({
        where: { code },
        select,
      });
      if (row?.isActive) return row;
      throw inactive();
    }
  }

  // ==========================================================
  // P16: e-mail verification and password reset
  // ==========================================================

  /** P17: e-mails a new 6-digit verification code (older codes stop working). */
  private async sendVerificationEmail(user: User, now = new Date()) {
    const code = await this.authTokens.issueCode(
      user.id,
      AuthTokenType.EMAIL_VERIFICATION,
      VERIFICATION_CODE_TTL_MS,
      this.prisma,
      now,
    );
    await this.accountEmail.sendVerificationCode(
      user.email,
      user.firstName,
      code,
      user.preferredLanguage,
    );
  }

  /**
   * Seconds until this user may receive another code: the 60-second cooldown, then the
   * hourly cap. 0 = a code can be sent now.
   */
  private async codeWaitSeconds(userId: string, now = new Date()) {
    const last = await this.authTokens.lastCodeIssuedAt(
      userId,
      AuthTokenType.EMAIL_VERIFICATION,
    );
    const cooldown = last
      ? last.getTime() + RESEND_COOLDOWN_MS - now.getTime()
      : 0;
    if (cooldown > 0) return Math.ceil(cooldown / 1000);
    const since = new Date(now.getTime() - HOUR_MS);
    const sent = await this.authTokens.countCodesSince(
      userId,
      AuthTokenType.EMAIL_VERIFICATION,
      since,
    );
    if (sent < VERIFICATION_CODES_PER_HOUR) return 0;
    // the oldest code of the last hour leaves the window first
    const recent = await this.prisma.authToken.findMany({
      where: {
        userId,
        type: AuthTokenType.EMAIL_VERIFICATION,
        attempts: { not: null },
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
      take: 1,
    });
    const freeAt = (recent[0]?.createdAt.getTime() ?? now.getTime()) + HOUR_MS;
    return Math.max(1, Math.ceil((freeAt - now.getTime()) / 1000));
  }

  /**
   * P17 public: verifies the account e-mail with the 6-digit code. Five wrong codes use
   * the code up. Unknown e-mail, wrong, expired or used code: the same 400.
   */
  async verifyEmailCode(email: string, code: string) {
    const user = await this.usersService.findByEmail(email);
    if (!user || !user.isActive) throw codeInvalid();
    if (user.emailVerifiedAt) {
      return {
        message: 'Your e-mail address is verified.',
        emailVerified: true,
      };
    }
    const result = await this.authTokens.checkCode(
      user.id,
      AuthTokenType.EMAIL_VERIFICATION,
      code,
    );
    if (result !== 'OK') throw codeInvalid();
    await this.prisma.user.updateMany({
      where: { id: user.id, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    });
    await this.universityIdentity.promoteAccountEmail(user.id);
    return { message: 'Your e-mail address is verified.', emailVerified: true };
  }

  /**
   * P17 public: sends a new code. Always the same answer (no account enumeration);
   * retryAfterSeconds is the wait before the next request (60 s cooldown, 5 per hour).
   */
  async resendVerificationCode(email: string) {
    const generic = (retryAfterSeconds: number) => ({
      message:
        'If this e-mail belongs to an account that is not verified yet, a new code has been sent.',
      retryAfterSeconds,
      emailDelivery: this.accountEmail.deliveryState,
    });
    const user = await this.usersService.findByEmail(email);
    if (!user || !user.isActive || user.emailVerifiedAt) {
      return generic(RESEND_COOLDOWN_MS / 1000);
    }
    const wait = await this.codeWaitSeconds(user.id);
    if (wait > 0) return generic(wait);
    await this.sendVerificationEmail(user);
    return generic(RESEND_COOLDOWN_MS / 1000);
  }

  /**
   * P17 public: an UNVERIFIED account moves to another address (e.g. a personal mailbox
   * when the university one drops our e-mails) and gets a new code there. Needs the
   * password. Supervisors stay on a university address of their university.
   */
  async changeUnverifiedEmail(
    currentEmail: string,
    password: string,
    newEmail: string,
  ) {
    const user = await this.usersService.findByEmail(currentEmail);
    const passwordOk = await this.usersService.validatePassword(
      password,
      user?.password ?? this.dummyPasswordHash,
    );
    if (!user || !passwordOk || !user.isActive) {
      throw new UnauthorizedException('Invalid email or password');
    }
    if (user.emailVerifiedAt) {
      throw new ConflictException({
        code: 'EMAIL_ALREADY_VERIFIED',
        message: 'Your e-mail address is already verified',
      });
    }
    const target = newEmail.trim().toLowerCase();
    if (target === user.email.toLowerCase()) {
      throw new BadRequestException({
        code: 'EMAIL_UNCHANGED',
        message: 'Enter a different e-mail address',
      });
    }
    if (user.role === UserRole.SUPERVISOR) {
      const university = user.universityId
        ? await this.prisma.university.findUnique({
            where: { id: user.universityId },
            select: { emailDomains: true },
          })
        : null;
      if (!emailDomainAllowed(target, university?.emailDomains ?? [])) {
        throw new BadRequestException({
          code: 'SUPERVISOR_UNIVERSITY_EMAIL_REQUIRED',
          message:
            'Academic supervisors use their university e-mail address of their university',
          details: { allowedDomains: university?.emailDomains ?? [] },
        });
      }
    }
    const other = await this.usersService.findByEmail(target);
    if (other && other.id !== user.id) {
      throw new ConflictException({
        code: 'EMAIL_TAKEN',
        message: 'This e-mail address is already used by another account',
      });
    }
    let updated: User;
    try {
      updated = await this.prisma.$transaction(async (tx) => {
        // codes sent to the old address stop working
        await tx.authToken.updateMany({
          where: {
            userId: user.id,
            type: AuthTokenType.EMAIL_VERIFICATION,
            usedAt: null,
          },
          data: { usedAt: new Date() },
        });
        return tx.user.update({
          where: { id: user.id },
          data: { email: target },
        });
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException({
          code: 'EMAIL_TAKEN',
          message: 'This e-mail address is already used by another account',
        });
      }
      throw error;
    }
    await this.sendVerificationEmail(updated);
    return {
      message: 'A verification code has been sent to the new address.',
      email: updated.email,
      retryAfterSeconds: RESEND_COOLDOWN_MS / 1000,
      emailDelivery: this.accountEmail.deliveryState,
    };
  }

  /** Public: confirms the address behind a verification link. Idempotent per user. */
  async verifyEmail(token: string) {
    const userId = await this.authTokens.consume(
      token,
      AuthTokenType.EMAIL_VERIFICATION,
    );
    await this.prisma.user.updateMany({
      where: { id: userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    });
    // the account e-mail may also be the student's university e-mail
    await this.universityIdentity.promoteAccountEmail(userId);
    return { message: 'Your e-mail address is verified.', emailVerified: true };
  }

  /** Authenticated: sends a new verification code (older codes stop working). */
  async resendVerification(userId: string) {
    const user = await this.usersService.findById(userId);
    if (!user) throw new UnauthorizedException('User not found');
    if (user.emailVerifiedAt) {
      throw new ConflictException({
        code: 'EMAIL_ALREADY_VERIFIED',
        message: 'Your e-mail address is already verified',
      });
    }
    const wait = await this.codeWaitSeconds(user.id);
    if (wait > 0) {
      throw new HttpException(
        {
          code: 'VERIFICATION_RECENTLY_SENT',
          message:
            'A verification code was just sent. Please wait before asking again.',
          details: { retryAfterSeconds: wait },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    await this.sendVerificationEmail(user);
    return {
      message: 'A new verification code has been sent to your e-mail address.',
      retryAfterSeconds: RESEND_COOLDOWN_MS / 1000,
      emailDelivery: this.accountEmail.deliveryState,
    };
  }

  /**
   * Public: always the same answer, whether or not the e-mail belongs to an account
   * (no account enumeration). Inactive accounts get no link.
   */
  async forgotPassword(email: string) {
    const user = await this.usersService.findByEmail(email);
    if (user?.isActive) {
      const token = await this.authTokens.issue(
        user.id,
        AuthTokenType.PASSWORD_RESET,
      );
      await this.accountEmail.sendPasswordReset(
        user.email,
        user.firstName,
        token,
        user.preferredLanguage,
      );
    }
    return {
      message:
        'If an account exists for this e-mail, a password reset link has been sent.',
      emailDelivery: this.accountEmail.deliveryState,
    };
  }

  /**
   * Public: sets a new password with a valid reset token. All refresh tokens are revoked
   * (every device signs in again). Using the link also proves the e-mail address.
   */
  async resetPassword(token: string, newPassword: string) {
    const resetUserId = await this.prisma.$transaction(async (tx) => {
      const userId = await this.authTokens.consume(
        token,
        AuthTokenType.PASSWORD_RESET,
        tx,
      );
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user || !user.isActive) {
        throw new BadRequestException({
          code: 'RESET_TOKEN_INVALID',
          message: 'This link is invalid or has expired. Request a new one.',
        });
      }
      await tx.user.update({
        where: { id: userId },
        data: {
          password: await this.usersService.hashPassword(newPassword),
          emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
        },
      });
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.authToken.updateMany({
        where: { userId, type: AuthTokenType.PASSWORD_RESET, usedAt: null },
        data: { usedAt: new Date() },
      });
      return userId;
    });
    this.logger.log(
      'Password reset completed; all sessions of the user were revoked',
    );
    // the reset link also proved the account e-mail, which may be the university e-mail
    await this.universityIdentity.promoteAccountEmail(resetUserId);
    return { message: 'Your password has been changed. Please sign in again.' };
  }

  /**
   * A SUPERVISOR account created by an ADMIN: the e-mailed link sets the first password
   * (and proves the e-mail). Single use, 7 days. 400 ACTIVATION_TOKEN_INVALID otherwise.
   */
  async activateAccount(token: string, newPassword: string) {
    await this.prisma.$transaction(async (tx) => {
      let userId: string;
      try {
        userId = await this.authTokens.consume(
          token,
          AuthTokenType.ACCOUNT_ACTIVATION,
          tx,
        );
      } catch {
        throw activationInvalid();
      }
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user || !user.isActive) throw activationInvalid();
      await tx.user.update({
        where: { id: userId },
        data: {
          password: await this.usersService.hashPassword(newPassword),
          emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
        },
      });
      await tx.authToken.updateMany({
        where: { userId, type: AuthTokenType.ACCOUNT_ACTIVATION, usedAt: null },
        data: { usedAt: new Date() },
      });
    });
    return { message: 'Your account is active. You can sign in now.' };
  }

  /** Email + password login. Same error for unknown email and wrong password. */
  async login(loginDto: LoginDto) {
    const { email, password } = loginDto;

    const user = await this.usersService.findByEmail(email);
    const isPasswordValid = await this.usersService.validatePassword(
      password,
      user?.password ?? this.dummyPasswordHash,
    );
    if (!user || !isPasswordValid) {
      throw new UnauthorizedException('Invalid email or password');
    }
    if (!user.isActive) {
      throw new UnauthorizedException('User account is inactive');
    }
    // the account type chosen on the sign-in page must be the account's own type
    // (administrators may sign in from either)
    if (
      loginDto.role &&
      user.role !== UserRole.ADMIN &&
      user.role !== loginDto.role
    ) {
      throw new ForbiddenException({
        code: 'LOGIN_ROLE_MISMATCH',
        message: 'Incorrect account type. Please try again.',
      });
    }

    const tokens = await this.generateTokens(user.id, user.email, user.role);
    return {
      user: toSafeUser(user),
      tokens,
      emailVerificationRequired: this.emailVerificationRequired,
    };
  }

  /**
   * Refresh token rotation: the presented token is revoked (atomically, once)
   * and a new access + refresh token pair is issued.
   */
  async refreshAccessToken(refreshToken: string) {
    if (!refreshToken) {
      throw new BadRequestException('Refresh token is required');
    }

    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(refreshToken) },
      include: { user: true },
    });

    if (record?.revokedAt) {
      // P14: a rotated token was presented again = it was probably stolen.
      // Revoke every active session of that user (OAuth 2.0 security BCP).
      await this.prisma.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      this.logger.warn(
        `Refresh token reuse detected; all sessions revoked for user ${record.userId}`,
      );
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    if (!record || record.expiresAt <= new Date()) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    if (!record.user.isActive) {
      throw new UnauthorizedException('User account is inactive');
    }

    // Conditional revoke: if two requests use the same token at once, only one wins.
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { id: record.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    return this.generateTokens(
      record.user.id,
      record.user.email,
      record.user.role,
    );
  }

  /** Revokes all still-active refresh tokens of the user. */
  async logout(userId: string) {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { message: 'Logout successful' };
  }

  private async generateTokens(
    userId: string,
    email: string,
    role: UserRole,
  ): Promise<AuthTokensDto> {
    const payload: JwtPayload = { sub: userId, email, role };
    const accessToken = this.jwtService.sign(payload, {
      expiresIn: this.jwtExpiration,
    });

    const rawRefreshToken = randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_TTL_DAYS);

    await this.prisma.refreshToken.create({
      data: { userId, tokenHash: hashRefreshToken(rawRefreshToken), expiresAt },
    });

    const decoded = this.jwtService.decode(accessToken) as {
      iat: number;
      exp: number;
    };
    return {
      accessToken,
      refreshToken: rawRefreshToken,
      expiresIn: decoded.exp - decoded.iat,
    };
  }
}
