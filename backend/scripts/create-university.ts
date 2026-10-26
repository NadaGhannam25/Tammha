/**
 * Creates (or re-activates) a real university record so students and
 * supervisors can register. Run once per university, after migrations:
 *
 *   npm run university:create -- --name "Almaarefa University" --code UM --city Riyadh --country "Saudi Arabia"
 *
 * Optional: --city, --country, --website
 * Reads DATABASE_URL from the project's root .env (see .env.example).
 * Idempotent: running it again with the same --code updates that university.
 */
// Loads .env from the current directory (npm scripts run from the project root).
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'path';
import { PrismaClient } from '@prisma/client';

// Also load the root .env explicitly, so the script works from any directory.
// Values already set (by the line above or by the shell) are never overwritten.
loadEnv({ path: resolve(__dirname, '..', '.env') });

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function readArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key.startsWith('--') && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      args[key.slice(2)] = argv[++i].trim();
    }
  }
  return args;
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (!args.name || !args.code) {
    fail(
      'Missing arguments.\n  Usage: npm run university:create -- --name "University Name" --code CODE [--city X] [--country Y] [--website URL]',
    );
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    fail(
      'DATABASE_URL is not set.\n' +
        `  Create ${resolve(__dirname, '..', '.env')} (copy .env.example) and set DATABASE_URL\n` +
        '  to your Supabase Transaction pooler connection string (Supabase > Connect).',
    );
  }
  if (
    databaseUrl.includes('[YOUR-PASSWORD]') ||
    databaseUrl.includes('[PROJECT_REF]')
  ) {
    fail(
      'DATABASE_URL still contains the .env.example placeholders. Replace them in .env.',
    );
  }

  const prisma = new PrismaClient();
  try {
    const data = {
      name: args.name,
      code: args.code.toUpperCase(),
      city: args.city ?? null,
      country: args.country ?? null,
      website: args.website ?? null,
      isActive: true,
    };
    const university = await prisma.university.upsert({
      where: { code: data.code },
      update: data,
      create: data,
    });
    console.log(`✔ University ready: ${university.name} (${university.code})`);
    console.log(`  universityId = ${university.id}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: Error & { code?: string }) => {
  const detail =
    error.message?.trim() ||
    `${error.name}${error.code ? ` (${error.code})` : ''}`;
  fail(`Failed to create university: ${detail}`);
});
