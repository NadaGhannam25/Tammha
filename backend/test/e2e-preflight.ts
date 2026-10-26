/**
 * Imported FIRST by the real-database E2E suite.
 * Loads <project root>/.env and refuses to start with a clear message when it
 * cannot be a real database (missing, placeholder, or the fake unit-test URL).
 */
import { config } from 'dotenv';
import { resolve } from 'path';

const envPath = resolve(__dirname, '..', '.env');
config({ path: envPath });

// P11: never run the background jobs here (they would write; this suite is read-only).
// Set before the app boots; process.env wins over .env values in ConfigModule.
process.env.REMINDERS_ENABLED = 'false';
process.env.EMAIL_ENABLED = 'false';

const url = (process.env.DATABASE_URL ?? '').trim();
const problems: string[] = [];

if (!url) {
  problems.push(`DATABASE_URL is not set (expected in ${envPath}).`);
} else if (!/^postgres(ql)?:\/\//.test(url)) {
  problems.push('DATABASE_URL is not a PostgreSQL connection string.');
} else if (
  /\[(YOUR-PASSWORD|PASSWORD|PROJECT_REF|PROJECT_HOST|REGION)\]/.test(url)
) {
  problems.push('DATABASE_URL still contains the .env.example placeholders.');
} else if (url.includes('tammha_test@127.0.0.1')) {
  problems.push(
    'DATABASE_URL is the fake unit-test value, not your Supabase database.',
  );
}

if (problems.length > 0) {
  throw new Error(
    `Real-database E2E suite not started:\n  - ${problems.join('\n  - ')}\n` +
      '  Set DATABASE_URL (Supabase > Connect > Transaction pooler) in your local .env.\n' +
      '  Unit/integration tests need no database: run `npm test` instead.',
  );
}
