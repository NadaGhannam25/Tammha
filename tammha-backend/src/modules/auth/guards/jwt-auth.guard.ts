import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { readEmailVerificationRequired } from '../email-verification.config';

export const ALLOW_UNVERIFIED_EMAIL = 'tammha:allowUnverifiedEmail';

/**
 * Routes an account with an UNVERIFIED e-mail may still call (the verification flow):
 * GET /auth/me, POST /auth/logout, POST /auth/resend-verification.
 */
export const AllowUnverifiedEmail = () =>
  SetMetadata(ALLOW_UNVERIFIED_EMAIL, true);

/**
 * JWT Authentication Guard
 * Verifies that a valid JWT access token is present in the Authorization header.
 *
 * When e-mail verification is required (EMAIL_VERIFICATION_REQUIRED, default: on when a
 * real e-mail provider is configured), an account whose e-mail is not verified gets
 * 403 EMAIL_NOT_VERIFIED on every product route — onboarding, projects, teams, AI … —
 * except the few marked @AllowUnverifiedEmail(). A STUDENT also needs a VERIFIED
 * university e-mail (403 UNIVERSITY_EMAIL_NOT_VERIFIED). The frontend sends the user to the
 * verification screen. Public routes (verify-email, forgot/reset password) need no token.
 *
 * Usage: @UseGuards(JwtAuthGuard)
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly verificationRequired: boolean;

  constructor(
    private readonly reflector: Reflector,
    config: ConfigService,
  ) {
    super();
    this.verificationRequired = readEmailVerificationRequired({
      EMAIL_VERIFICATION_REQUIRED: config.get<string>(
        'EMAIL_VERIFICATION_REQUIRED',
      ),
      EMAIL_ENABLED: config.get<string>('EMAIL_ENABLED'),
      NODE_ENV: config.get<string>('NODE_ENV'),
    }).required;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const ok = (await super.canActivate(context)) as boolean;
    if (!ok || !this.verificationRequired) return ok;
    const allowed = this.reflector.getAllAndOverride<boolean>(
      ALLOW_UNVERIFIED_EMAIL,
      [context.getHandler(), context.getClass()],
    );
    if (allowed) return true;
    const user = context.switchToHttp().getRequest().user as
      | {
          role?: string;
          emailVerifiedAt?: Date | null;
          universityEmailVerifiedAt?: Date | null;
          pendingUniversityEmail?: string | null;
        }
      | undefined;
    if (!user?.emailVerifiedAt) {
      throw new ForbiddenException({
        code: 'EMAIL_NOT_VERIFIED',
        message:
          'Please verify your e-mail address first. Enter the code we sent you, or ask for a new one.',
        details: {
          verifyWith: 'POST /auth/verify-email/code',
          resendWith: 'POST /auth/verify-email/resend',
        },
      });
    }
    // STUDENT: full access also needs a VERIFIED university e-mail (the same address as
    // the account e-mail for most students, so one link verifies both)
    if (user.role === 'STUDENT' && !user.universityEmailVerifiedAt) {
      throw new ForbiddenException({
        code: 'UNIVERSITY_EMAIL_NOT_VERIFIED',
        message: user.pendingUniversityEmail
          ? 'Please verify your university e-mail address first. Use the link we sent to it, or ask for a new one.'
          : 'Please add and verify your university e-mail address to continue.',
        details: {
          pending: !!user.pendingUniversityEmail,
          requestWith: 'POST /auth/university-email',
          verifyWith: 'POST /auth/verify-university-email',
        },
      });
    }
    return true;
  }
}
