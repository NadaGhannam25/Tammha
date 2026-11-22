import { BadRequestException, Injectable } from '@nestjs/common';
import { AuthTokenType, Prisma } from '@prisma/client';
import { createHash, randomBytes, randomInt } from 'crypto';
import { PrismaService } from '@/prisma/prisma.service';

type Db = PrismaService | Prisma.TransactionClient;

export const AUTH_TOKEN_TTL_MS: Record<AuthTokenType, number> = {
  EMAIL_VERIFICATION: 24 * 60 * 60 * 1000, // 24 hours
  PASSWORD_RESET: 30 * 60 * 1000, // 30 minutes
  UNIVERSITY_EMAIL_VERIFICATION: 24 * 60 * 60 * 1000, // 24 hours
  ACCOUNT_ACTIVATION: 7 * 24 * 60 * 60 * 1000, // 7 days (supervisor accounts)
  ACCOUNT_DELETION: 15 * 60 * 1000, // 15 minutes (6-digit code)
  PROJECT_DELETION: 15 * 60 * 1000, // 15 minutes (6-digit code)
};

const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');

/** Wrong attempts allowed per 6-digit code; the code stops working after that. */
export const CODE_MAX_ATTEMPTS = 5;

/**
 * A 6-digit code is only stored as SHA-256 of (purpose, user, issue time, code, server
 * secret): the issue time makes every row unique (tokenHash is unique) and the secret
 * keeps a leaked table from being brute-forced offline.
 */
const codeHash = (
  type: AuthTokenType,
  userId: string,
  issuedAt: Date,
  code: string,
) =>
  hash(
    `code:${type}:${userId}:${issuedAt.getTime()}:${code}:${
      process.env.AUTH_CODE_PEPPER || process.env.JWT_SECRET || ''
    }`,
  );

export type CodeCheck = 'OK' | 'INVALID' | 'NO_CODE';

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

  // ---------- 6-digit codes ----------

  /**
   * Issues a new 6-digit code (crypto-secure) of this type: every older unused CODE of the
   * same type for the user stops working. Link tokens of the same type are left alone
   * (already-sent links keep working until they expire).
   */
  async issueCode(
    userId: string,
    type: AuthTokenType,
    ttlMs: number,
    db: Db = this.prisma,
    now = new Date(),
    ref?: string,
  ): Promise<string> {
    await db.authToken.updateMany({
      where: { userId, type, usedAt: null, attempts: { not: null } },
      data: { usedAt: now },
    });
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await db.authToken.create({
      data: {
        userId,
        type,
        tokenHash: codeHash(type, userId, now, code),
        expiresAt: new Date(now.getTime() + ttlMs),
        createdAt: now,
        attempts: 0,
        // what the code is for (PROJECT_DELETION: the project id)
        ...(ref ? { email: ref } : {}),
      },
    });
    return code;
  }

  /**
   * Checks the user's current code. A wrong code counts an attempt; after
   * CODE_MAX_ATTEMPTS the code is used up. The right code is consumed (single use,
   * compare-and-set). NO_CODE: none issued, expired or used up.
   */
  async checkCode(
    userId: string,
    type: AuthTokenType,
    code: string,
    now = new Date(),
    ref?: string,
  ): Promise<CodeCheck> {
    const row = await this.prisma.authToken.findFirst({
      where: { userId, type, usedAt: null, attempts: { not: null } },
      orderBy: { createdAt: 'desc' },
    });
    if (!row || row.expiresAt <= now) return 'NO_CODE';
    // a code issued for something else (another project) does not count here
    if (ref !== undefined && row.email !== ref) return 'NO_CODE';
    if (row.tokenHash !== codeHash(type, userId, row.createdAt, code.trim())) {
      const attempts = (row.attempts ?? 0) + 1;
      await this.prisma.authToken.update({
        where: { id: row.id },
        data: {
          attempts,
          ...(attempts >= CODE_MAX_ATTEMPTS ? { usedAt: now } : {}),
        },
      });
      return 'INVALID';
    }
    const { count } = await this.prisma.authToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: now },
    });
    return count === 1 ? 'OK' : 'NO_CODE';
  }

  /** Codes of this type issued to the user since `since` (hourly send cap). */
  countCodesSince(userId: string, type: AuthTokenType, since: Date) {
    return this.prisma.authToken.count({
      where: {
        userId,
        type,
        attempts: { not: null },
        createdAt: { gte: since },
      },
    });
  }

  /** When the user last received a CODE of this type (resend cooldown). */
  async lastCodeIssuedAt(userId: string, type: AuthTokenType) {
    const last = await this.prisma.authToken.findFirst({
      where: { userId, type, attempts: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return last?.createdAt ?? null;
  }
}
