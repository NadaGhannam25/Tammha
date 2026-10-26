/**
 * Creates the ADMIN account (P15). Needed for the admin handbook API and the
 * deployment check (GET /admin/diagnostics/request). ADMIN cannot self-register.
 *
 *   # the password comes from your shell, never from arguments or chat:
 *   #   macOS/Linux:  read -s ADMIN_PASSWORD && export ADMIN_PASSWORD
 *   #   PowerShell:   $env:ADMIN_PASSWORD = Read-Host -MaskInput
 *   npm run admin:create -- --email admin@your-university.edu [--first Rand --last Admin]
 *
 * - Uses DATABASE_URL from the root .env (point it at the production database to create
 *   the production admin) and BCRYPT_ROUNDS (default 10, minimum 10).
 * - Same password policy as registration (8-128 chars, <= 72 bytes, a letter and a digit).
 * - Idempotent: an existing ADMIN with that e-mail gets the new password; an existing
 *   STUDENT/SUPERVISOR account is NEVER promoted (refused).
 * - Never prints the password or its hash.
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'path';
import * as bcrypt from 'bcrypt';
import { PrismaClient, UserRole } from '@prisma/client';
import { passwordPolicyProblem } from '../src/common/utils/password-policy.validator';

loadEnv({ path: resolve(__dirname, '..', '.env') });

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function readArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (
      argv[i].startsWith('--') &&
      argv[i + 1] &&
      !argv[i + 1].startsWith('--')
    ) {
      args[argv[i].slice(2)] = argv[++i].trim();
    }
  }
  return args;
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const email = (args.email ?? '').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fail(
      'Usage: npm run admin:create -- --email admin@example.edu [--first X --last Y]',
    );
  }
  const password = process.env.ADMIN_PASSWORD ?? '';
  if (!password) {
    fail(
      'Set ADMIN_PASSWORD in your shell first (see the comment at the top of scripts/create-admin.ts).',
    );
  }
  const problem = passwordPolicyProblem(password);
  if (problem || password.length < 12) {
    fail(
      `ADMIN_PASSWORD rejected: ${problem ?? 'use at least 12 characters for the admin account'}`,
    );
  }
  const rounds = Math.max(10, Number(process.env.BCRYPT_ROUNDS) || 10);
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl || databaseUrl.includes('[YOUR-PASSWORD]')) {
    fail(
      'DATABASE_URL is not set in .env (Supabase > Connect > Transaction pooler).',
    );
  }

  const prisma = new PrismaClient();
  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing && existing.role !== UserRole.ADMIN) {
      fail(
        `${email} already exists as ${existing.role}; it will not be promoted. Use another e-mail.`,
      );
    }
    const hash = await bcrypt.hash(password, rounds);
    if (existing) {
      await prisma.user.update({
        where: { id: existing.id },
        data: { password: hash, isActive: true },
      });
      await prisma.refreshToken.updateMany({
        where: { userId: existing.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      console.log(`✔ ADMIN password updated: ${email} (old sessions revoked)`);
    } else {
      const user = await prisma.user.create({
        data: {
          email,
          password: hash,
          role: UserRole.ADMIN,
          firstName: args.first ?? 'Admin',
          lastName: args.last ?? null,
          isActive: true,
        },
      });
      console.log(`✔ ADMIN created: ${email} (id ${user.id})`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: Error & { code?: string }) => {
  fail(`Failed to create the admin: ${error.message?.trim() || error.name}`);
});
