import { BadRequestException, Injectable } from '@nestjs/common';
import { AuthTokenType, Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '@/prisma/prisma.service';

type Db = PrismaService | Prisma.TransactionClient;

export const AUTH_TOKEN_TTL_MS: Record<AuthTokenType, number> = {
  EMAIL_VERIFICATION: 24 * 60 * 60 * 1000, // 24 hours
  PASSWORD_RESET: 30 * 60 * 1000, // 30 minutes
  UNIVERSITY_EMAIL_VERIFICATION: 24 * 60 * 60 * 1000, // 24 hours
  ACCOUNT_ACTIVATION: 7 * 24 * 60 * 60 * 1000, // 7 days (supervisor accounts)
  ACCOUNT_DELETION: 15 * 60 * 1000, // 15 minutes (6-digit code)
};

const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');

/**
 * P16: single-use account tokens (e-mail verification, password reset).
 * The raw token (32 random bytes, base64url) only exists in the e-mail link;
 * the database keeps its SHA-256 digest. Issuing a new token invalidates older
 * unused tokens of the same type for that user.
 */
@Injectable()
export class AuthTokensService {
  constructor(private readonly prisma: PrismaService) {}

  async issue(
    userId: string,
    type: AuthTokenType,
    db: Db = this.prisma,
    now = new Date(),
    email: string | null = null,
  ): Promise<string> {
    await db.authToken.updateMany({
      where: { userId, type, usedAt: null },
      data: { usedAt: now },
    });
    const raw = randomBytes(32).toString('base64url');
    await db.authToken.create({
      data: {
        userId,
        type,
        tokenHash: hash(raw),
        expiresAt: new Date(now.getTime() + AUTH_TOKEN_TTL_MS[type]),
        // same clock as expiresAt and the resend cooldown
        createdAt: now,
        // UNIVERSITY_EMAIL_VERIFICATION: the address this link proves
        email,
      },
    });
    return raw;
  }

  /** When the user last received a token of this type (resend cooldown). */
  async lastIssuedAt(userId: string, type: AuthTokenType) {
    const last = await this.prisma.authToken.findFirst({
      where: { userId, type },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return last?.createdAt ?? null;
  }

  /**
   * Marks the token used and returns its user id. Unknown, used, expired or
   * wrong-type tokens all give the same 400 (no hint which one it was).
   * Compare-and-set: two concurrent uses of one token cannot both succeed.
   */
  async consume(
    raw: string,
    type: AuthTokenType,
    db: Db = this.prisma,
    now = new Date(),
  ): Promise<string> {
    return (await this.consumeRecord(raw, type, db, now)).userId;
  }

  /** Same as consume(), also returning the address the token was issued for. */
  async consumeRecord(
    raw: string,
    type: AuthTokenType,
    db: Db = this.prisma,
    now = new Date(),
  ): Promise<{ userId: string; email: string | null }> {
    const row = await db.authToken.findUnique({
      where: { tokenHash: hash(raw) },
    });
    const invalid = () =>
      new BadRequestException({
        code:
          type === 'PASSWORD_RESET'
            ? 'RESET_TOKEN_INVALID'
            : 'VERIFICATION_TOKEN_INVALID',
        message: 'This link is invalid or has expired. Request a new one.',
      });
    if (!row || row.type !== type || row.usedAt || row.expiresAt <= now) {
      throw invalid();
    }
    const { count } = await db.authToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: now },
    });
    if (count === 0) throw invalid();
    return { userId: row.userId, email: row.email ?? null };
  }
}
