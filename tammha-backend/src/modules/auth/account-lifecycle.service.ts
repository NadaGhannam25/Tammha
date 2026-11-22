import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuthTokenType,
  ProjectRole,
  SupervisionRequestStatus,
  TeamRole,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { PrismaService } from '@/prisma/prisma.service';
import { AuthUser } from '@common/types/auth-user.type';
import { AUTH_TOKEN_TTL_MS, AuthTokensService } from './auth-tokens.service';
import { AccountEmailService } from './account-email.service';

/** A second password link from the settings page within this window is not sent again. */
export const PASSWORD_LINK_REPEAT_MS = 5 * 60_000;
/** A new deletion code can be requested once a minute. */
const DELETION_CODE_COOLDOWN_MS = 60_000;

const err = (code: string, message: string, details?: object) => ({
  code,
  message,
  ...(details ? { details } : {}),
});

/**
 * Settings page actions on the signed-in account:
 * - password link: e-mails a reset link; a second request within 5 minutes is answered
 *   with alreadySent=true and nothing is sent again.
 * - account deletion: a 6-digit code is e-mailed (15 minutes, 5 attempts); entering it
 *   deletes the account. A team leader whose team has other members, or a supervisor who
 *   still supervises projects, must hand over first (409).
 *
 * Deleting removes the personal data (name, e-mail, photo, student number, university
 * e-mail, college, major), signs out every device and disables the account. The user row
 * itself stays (anonymised) because tasks, files, feedback and meetings of the team keep
 * pointing at it. The e-mail can be used to register again.
 */
@Injectable()
export class AccountLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authTokens: AuthTokensService,
    private readonly accountEmail: AccountEmailService,
  ) {}

  async sendPasswordLink(user: AuthUser, now = new Date()) {
    const account = await this.activeAccount(user.id);
    const last = await this.authTokens.lastIssuedAt(
      account.id,
      AuthTokenType.PASSWORD_RESET,
    );
    const waitMs = last
      ? last.getTime() + PASSWORD_LINK_REPEAT_MS - now.getTime()
      : 0;
    if (waitMs > 0) {
      return {
        email: account.email,
        alreadySent: true,
        retryAfterSeconds: Math.ceil(waitMs / 1000),
        emailDelivery: this.accountEmail.deliveryState,
      };
    }
    const token = await this.authTokens.issue(
      account.id,
      AuthTokenType.PASSWORD_RESET,
      this.prisma,
      now,
    );
    await this.accountEmail.sendPasswordReset(
      account.email,
      account.firstName,
      token,
      account.preferredLanguage,
    );
    return {
      email: account.email,
      alreadySent: false,
      retryAfterSeconds: Math.ceil(PASSWORD_LINK_REPEAT_MS / 1000),
      emailDelivery: this.accountEmail.deliveryState,
    };
  }

  /** What blocks deleting this account (empty = it can be deleted). */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async deletionBlockers(_userId: string) {
    // Nothing blocks it any more: every student of a team has the same permissions, so a
    // project owner's projects pass to the earliest remaining member on deletion, and a
    // supervisor's supervision of each project simply ends (the projects stay with their
    // teams, who can then ask another supervisor).
    return [] as { code: string; name: string }[];
  }

  async requestDeletion(user: AuthUser, now = new Date()) {
    const account = await this.activeAccount(user.id);
    await this.assertDeletable(account.id);
    const last = await this.authTokens.lastCodeIssuedAt(
      account.id,
      AuthTokenType.ACCOUNT_DELETION,
    );
    const waitMs = last
      ? last.getTime() + DELETION_CODE_COOLDOWN_MS - now.getTime()
      : 0;
    if (waitMs > 0) {
      throw new HttpException(
        err('DELETION_CODE_RECENTLY_SENT', 'A code was sent a moment ago', {
          retryAfterSeconds: Math.ceil(waitMs / 1000),
        }),
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const code = await this.authTokens.issueCode(
      account.id,
      AuthTokenType.ACCOUNT_DELETION,
      AUTH_TOKEN_TTL_MS[AuthTokenType.ACCOUNT_DELETION],
      this.prisma,
      now,
    );
    await this.accountEmail.sendAccountDeletionCode(
      account.email,
      account.firstName,
      code,
      account.preferredLanguage,
    );
    return {
      email: account.email,
      expiresInSeconds:
        AUTH_TOKEN_TTL_MS[AuthTokenType.ACCOUNT_DELETION] / 1000,
      emailDelivery: this.accountEmail.deliveryState,
    };
  }

  async confirmDeletion(user: AuthUser, code: string, now = new Date()) {
    const account = await this.activeAccount(user.id);
    const invalid = () =>
      new BadRequestException(
        err(
          'DELETION_CODE_INVALID',
          'The code is incorrect or has expired. Request a new one.',
        ),
      );
    // a blocked account keeps its code (nothing is consumed)
    await this.assertDeletable(account.id);
    const check = await this.authTokens.checkCode(
      account.id,
      AuthTokenType.ACCOUNT_DELETION,
      code,
      now,
    );
    if (check !== 'OK') throw invalid();

    const scrambled = await bcrypt.hash(randomBytes(24).toString('hex'), 10);
    await this.prisma.$transaction(async (tx) => {
      await tx.refreshToken.updateMany({
        where: { userId: account.id, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.authToken.updateMany({
        where: { userId: account.id, usedAt: null },
        data: { usedAt: now },
      });
      // an ordinary member leaves the team; a project owner leaves it too and the earliest
      // remaining member becomes the owner; an owner alone in the team keeps the empty team
      const owned = await tx.teamMember.findMany({
        where: { userId: account.id, role: TeamRole.LEADER },
        select: { id: true, teamId: true },
      });
      for (const own of owned) {
        const next = await tx.teamMember.findFirst({
          where: { teamId: own.teamId, userId: { not: account.id } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        if (!next) continue;
        await tx.teamMember.delete({ where: { id: own.id } });
        await tx.teamMember.update({
          where: { id: next.id },
          data: { role: TeamRole.LEADER },
        });
      }
      await tx.teamMember.deleteMany({
        where: { userId: account.id, role: TeamRole.MEMBER },
      });
      // a supervisor: the supervision of every project ends, and open requests are closed
      await tx.projectMember.deleteMany({
        where: { userId: account.id, role: ProjectRole.PROJECT_MANAGER },
      });
      await tx.supervisionRequest.updateMany({
        where: {
          supervisorId: account.id,
          status: {
            in: [
              SupervisionRequestStatus.PENDING,
              SupervisionRequestStatus.ACCEPTED,
            ],
          },
        },
        data: { status: SupervisionRequestStatus.CANCELLED },
      });
      await tx.user.update({
        where: { id: account.id },
        data: {
          email: `deleted-${account.id}@deleted.tammha.invalid`,
          password: scrambled,
          firstName: 'حساب',
          lastName: 'محذوف',
          avatar: null,
          bio: null,
          college: null,
          major: null,
          studentNumber: null,
          universityEmail: null,
          universityEmailVerifiedAt: null,
          pendingUniversityEmail: null,
          isActive: false,
          deletedAt: now,
        },
      });
    });
    await this.accountEmail.sendAccountDeleted(
      account.email,
      account.firstName,
      account.preferredLanguage,
    );
    return { deleted: true };
  }

  private async assertDeletable(userId: string) {
    const blockers = await this.deletionBlockers(userId);
    if (blockers.length) {
      throw new ConflictException(
        err('ACCOUNT_DELETION_BLOCKED', 'Hand over the team leadership first', {
          blockers,
        }),
      );
    }
  }

  private async activeAccount(userId: string) {
    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        preferredLanguage: true,
        isActive: true,
      },
    });
    if (!account || !account.isActive) {
      throw new NotFoundException(err('USER_NOT_FOUND', 'Account not found'));
    }
    return account;
  }
}
