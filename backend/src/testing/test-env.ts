/**
 * TEST-ONLY deterministic configuration for unit and integration tests.
 *
 * Why this exists: @nestjs/config resolves `process.env` BEFORE values passed with
 * `load: [...]`, and the generated Prisma Client copies the developer's `.env` into
 * `process.env` when it is imported. Without this file, tests silently picked up
 * local values such as JWT_EXPIRATION=7d or BCRYPT_ROUNDS=10.
 *
 * `applyTestEnv()` runs before every test file (jest `setupFiles`) and OVERWRITES every
 * variable the application reads. Prisma and dotenv never overwrite an existing value,
 * so the developer's `.env` can no longer change test behaviour.
 *
 * Only fake values: no connection is ever made (PrismaService is replaced in tests).
 * The real application keeps reading its own environment; nothing here is used in
 * development or production. The real-database E2E suite does NOT use this file.
 */

import { ConfigModule } from '@nestjs/config';
import { validateEnv } from '@/config/env.validation';

/** Every variable the application reads (see src/config/env.validation.ts and services). */
export const TEST_ENV = {
  NODE_ENV: 'test',
  PORT: '3000',
  API_VERSION: 'v1',
  DATABASE_URL:
    'postgresql://tammha_test:tammha_test@127.0.0.1:5432/tammha_test',
  DIRECT_URL: 'postgresql://tammha_test:tammha_test@127.0.0.1:5432/tammha_test',
  JWT_SECRET: 'test-only-jwt-secret-not-used-outside-jest-0123456789',
  JWT_EXPIRATION: '1h',
  // Lower cost ONLY for test speed. The application default stays 10 (BCRYPT_ROUNDS).
  BCRYPT_ROUNDS: '4',
  CORS_ORIGINS: 'http://localhost:5173',
  SUPABASE_URL: 'https://test-project.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_test-only-not-a-real-secret',
  INVITATION_LINK_BASE_URL: 'https://tammha.test/join',
  TEAM_MAX_MEMBERS: '',
  REQUIRED_DOCUMENT_CATEGORIES: '',
  // P10 integrations: all OFF in tests (and a developer's real keys never leak in)
  LIVEKIT_ENABLED: '',
  LIVEKIT_URL: '',
  LIVEKIT_API_KEY: '',
  LIVEKIT_API_SECRET: '',
  LIVEKIT_TOKEN_TTL_SECONDS: '',
  AI_ENABLED: '',
  AI_PROVIDER: '',
  AI_REQUEST_TIMEOUT_MS: '',
  GEMINI_API_KEY: '',
  GEMINI_MODEL: '',
  EMAIL_ENABLED: '',
  // P11: no background jobs in tests (they are called directly where needed)
  REMINDERS_ENABLED: 'false',
  REMINDER_INTERVAL_MINUTES: '',
  TASK_REMINDER_HOURS_BEFORE: '',
  OVERDUE_LOOKBACK_DAYS: '',
  EMAIL_DISPATCH_INTERVAL_SECONDS: '',
  EMAIL_MAX_ATTEMPTS: '',
  // P12 meetings
  MEETING_JOIN_EARLY_MINUTES: '',
  MEETING_JOIN_GRACE_MINUTES: '',
  // P13 AI support (AI_ENABLED stays off; suites that need it enable Gemini with a fake provider)
  AI_USER_HOURLY_LIMIT: '',
  AI_USER_DAILY_LIMIT: '',
  AI_PROJECT_DAILY_LIMIT: '',
  AI_MAX_OUTPUT_TOKENS: '',
  AI_HANDBOOK_MAX_CHARS: '',
  AI_HANDBOOK_MAX_EXCERPTS: '',
  HANDBOOK_MAX_FILE_MB: '',
  // P14 security: rate limiting off by default in tests (the throttling suite turns it on)
  FRONTEND_ORIGIN: '',
  RATE_LIMIT_ENABLED: 'false',
  RATE_LIMIT_PER_MINUTE: '',
  AUTH_RATE_LIMIT_PER_MINUTE: '',
  SWAGGER_ENABLED: '',
  TRUST_PROXY: '',
  // P15 deployment
  CLIENT_IP_HEADER: '',
  PUBLIC_BASE_URL: '',
} as const;

export type TestEnvOverrides = Partial<Record<keyof typeof TEST_ENV, string>>;

/** Overwrites process.env with the deterministic test values (+ optional overrides). */
export function applyTestEnv(overrides: TestEnvOverrides = {}): void {
  Object.assign(process.env, TEST_ENV, overrides);
}

/**
 * ConfigModule for integration tests: same validation as the app, no .env file,
 * values from TEST_ENV plus per-suite overrides (e.g. { TEAM_MAX_MEMBERS: '4' }).
 * Call it inside beforeAll, before compiling the testing module.
 */
export function testConfigModule(overrides: TestEnvOverrides = {}) {
  applyTestEnv(overrides);
  return ConfigModule.forRoot({
    isGlobal: true,
    ignoreEnvFile: true,
    validate: validateEnv,
  });
}
