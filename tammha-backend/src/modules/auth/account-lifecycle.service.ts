import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuthTokenType, ProjectRole, TeamRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes, randomInt } from 'crypto';
import { PrismaService } from '@/prisma/prisma.service';
import { AuthUser } from '@common/types/auth-user.type';
import { AUTH_TOKEN_TTL_MS, AuthTokensService } from './auth-tokens.service';
import { AccountEmailService } from './account-email.service';

/** A second password link from the settings page within this window is not sent again. */
export const PASSWORD_LINK_REPEAT_MS = 5 * 60_000;
/** A new deletion code can be requested once a minute. */
const DELETION_CODE_COOLDOWN_MS = 60_000;
/** Wrong codes allowed before the code stops working. */
const DELETION_MAX_ATTEMPTS = 5;

const err = (code: string, message: string, details?: object) => ({
  code,
  message,
  ...(details ? { details } : {}),
});

const codeHash = (userId: string, issuedAt: Date, code: string) =>
  createHash('sha256')
    .update(`account-deletion:${userId}:${issuedAt.getTime()}:${code}`)
    .digest('hex');

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
  async deletionBlockers(userId: string) {
    const blockers: { code: string; name: string }[] = [];
    const leading = await this.prisma.teamMember.findMany({
      where: { userId, role: TeamRole.LEADER },
      select: { teamId: true },
    });
    for (const { teamId } of leading) {
      const others = await this.prisma.teamMember.count({
        where: { teamId, userId: { not: userId } },
      });
      if (others > 0) {
        const team = await this.prisma.team.findUnique({
          where: { id: teamId },
          select: { name: true },
        });
        blockers.push({ code: 'TEAM_LEADER', name: team?.name ?? '' });
      }
    }
    const supervising = await this.prisma.projectMember.findMany({
      where: { userId, role: ProjectRole.PROJECT_MANAGER },
      select: { projectId: true },
    });
    if (supervising.length) {
      const projects = await this.prisma.project.findMany({
        where: { id: { in: supervising.map((s) => s.projectId) } },
        select: { name: true },
      });
      for (const p of projects)
        blockers.push({ code: 'SUPERVISOR', name: p.name });
    }
    return blockers;
  }

  async requestDeletion(user: AuthUser, now = new Date()) {
    const account = await this.activeAccount(user.id);
    await this.assertDeletable(account.id);
    const last = await this.authTokens.lastIssuedAt(
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
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.prisma.authToken.updateMany({
      where: {
        userId: account.id,
        type: AuthTokenType.ACCOUNT_DELETION,
        usedAt: null,
      },
      data: { usedAt: now },
    });
    await this.prisma.authToken.create({
      data: {
        userId: account.id,
        type: AuthTokenType.ACCOUNT_DELETION,
        tokenHash: codeHash(account.id, now, code),
        expiresAt: new Date(
          now.getTime() + AUTH_TOKEN_TTL_MS[AuthTokenType.ACCOUNT_DELETION],
        ),
        createdAt: now,
        // wrong attempts so far (this token type has no e-mail of its own)
        email: '0',
      },
    });
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
    const row = await this.prisma.authToken.findFirst({
      where: {
        userId: account.id,
        type: AuthTokenType.ACCOUNT_DELETION,
        usedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!row || row.expiresAt <= now) throw invalid();
    if (row.tokenHash !== codeHash(account.id, row.createdAt, code.trim())) {
      const attempts = Number(row.email ?? '0') + 1;
      await this.prisma.authToken.update({
        where: { id: row.id },
        data: {
          email: String(attempts),
          ...(attempts >= DELETION_MAX_ATTEMPTS ? { usedAt: now } : {}),
        },
      });
      throw invalid();
    }
    await this.assertDeletable(account.id);

    const scrambled = await bcrypt.hash(randomBytes(24).toString('hex'), 10);
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.authToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: now },
      });
      if (count === 0) throw invalid();
      await tx.refreshToken.updateMany({
        where: { userId: account.id, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.authToken.updateMany({
        where: { userId: account.id, usedAt: null },
        data: { usedAt: now },
      });
      // an ordinary member leaves the team; a leader alone in the team keeps the empty team
      await tx.teamMember.deleteMany({
        where: { userId: account.id, role: TeamRole.MEMBER },
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
        err(
          'ACCOUNT_DELETION_BLOCKED',
          'Hand over the team leadership or the supervised projects first',
          { blockers },
        ),
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
