import { parseRequiredDocumentCategories } from '../modules/dashboard/progress/progress.rules';
import { readIntegrationsConfig } from '../integrations/integrations.config';
import { readNotificationSettings } from '../modules/notifications/notifications.config';
import { readMeetingSettings } from '../modules/meetings/meetings.config';
import { readAiSupportSettings } from '../modules/ai-support/ai-support.config';
import { readSecuritySettings } from './security.config';

/**
 * Validates environment variables at startup (ConfigModule.forRoot({ validate })).
 * The app refuses to start with a clear message instead of failing later at runtime.
 */
const PLACEHOLDER_MARKERS = [
  'change-this',
  'your-secret',
  '[PASSWORD]',
  '[PROJECT_REF]',
  '[REGION]',
];

export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const errors: string[] = [];
  const str = (key: string) =>
    typeof config[key] === 'string' ? (config[key] as string).trim() : '';
  const nodeEnv = str('NODE_ENV') || 'development';

  if (!['development', 'production', 'test'].includes(nodeEnv)) {
    errors.push('NODE_ENV must be development, production or test');
  }

  const databaseUrl = str('DATABASE_URL');
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    errors.push(
      'DATABASE_URL must be set to a PostgreSQL connection string (Supabase pooler URL)',
    );
  } else if (PLACEHOLDER_MARKERS.some((m) => databaseUrl.includes(m))) {
    errors.push('DATABASE_URL still contains the .env.example placeholders');
  }

  const jwtSecret = str('JWT_SECRET');
  if (jwtSecret.length < 32) {
    errors.push('JWT_SECRET must be set and at least 32 characters long');
  } else if (
    nodeEnv === 'production' &&
    PLACEHOLDER_MARKERS.some((m) => jwtSecret.includes(m))
  ) {
    errors.push('JWT_SECRET still uses the .env.example placeholder');
  }

  const intInRange = (key: string, min: number, max: number) => {
    const raw = str(key);
    if (!raw) return;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      errors.push(`${key} must be an integer between ${min} and ${max}`);
    }
  };
  intInRange('PORT', 1, 65535);
  intInRange('BCRYPT_ROUNDS', 4, 15);
  intInRange('TEAM_MAX_MEMBERS', 1, 100);

  const jwtExpiration = str('JWT_EXPIRATION');
  if (jwtExpiration && !/^\d+[smhd]?$/.test(jwtExpiration)) {
    errors.push('JWT_EXPIRATION must look like 3600, 15m, 1h or 7d');
  }

  const inviteBase = str('INVITATION_LINK_BASE_URL');
  if (inviteBase && !/^https?:\/\/\S+$/.test(inviteBase)) {
    errors.push('INVITATION_LINK_BASE_URL must be an http(s) URL');
  }

  // ---- P09: documents required for project readiness (optional) ----
  const required = parseRequiredDocumentCategories(
    str('REQUIRED_DOCUMENT_CATEGORIES'),
  );
  if (required.error) errors.push(required.error);

  // ---- Supabase Storage (P07 documents). Values are never echoed in messages. ----
  const supabaseUrl = str('SUPABASE_URL');
  if (!supabaseUrl) {
    errors.push(
      'SUPABASE_URL must be set (Supabase > Project Settings > Data API > Project URL)',
    );
  } else if (
    !/^https:\/\/[^\s/]+\/?$/.test(supabaseUrl) &&
    !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(supabaseUrl)
  ) {
    errors.push(
      'SUPABASE_URL must be the https project URL, e.g. https://<project-ref>.supabase.co',
    );
  } else if (supabaseUrl.includes('your-project')) {
    errors.push('SUPABASE_URL still contains the .env.example placeholder');
  }

  const secretKeyProblem = checkSupabaseSecretKey(str('SUPABASE_SECRET_KEY'));
  if (secretKeyProblem) errors.push(secretKeyProblem);

  // ---- P10: external integrations (required only when enabled) ----
  errors.push(...readIntegrationsConfig(config).errors);

  // ---- P11: reminders and email dispatch (all optional) ----
  errors.push(...readNotificationSettings(config).errors);

  // ---- P12: meeting join window (optional) ----
  errors.push(...readMeetingSettings(config).errors);

  // ---- P13: AI support limits and handbook settings (optional) ----
  errors.push(...readAiSupportSettings(config).errors);

  // ---- P14: CORS, rate limiting, Swagger, proxy, bcrypt cost in production ----
  errors.push(...readSecuritySettings(config).errors);

  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration (check your .env):\n  - ${errors.join('\n  - ')}`,
    );
  }
  return config;
}

/**
 * SUPABASE_SECRET_KEY must be a SERVER key: a secret key (sb_secret_...) or the
 * legacy service_role JWT. The publishable/anon key is rejected: it cannot use the
 * private bucket and must never be confused with the secret one.
 */
function checkSupabaseSecretKey(key: string): string | null {
  const where = 'Supabase > Project Settings > API Keys > Secret keys';
  if (!key) return `SUPABASE_SECRET_KEY must be set (${where})`;
  if (/^(your-|\[)|keep-secret|change-this/i.test(key)) {
    return 'SUPABASE_SECRET_KEY still contains the .env.example placeholder';
  }
  if (key.startsWith('sb_publishable_')) {
    return `SUPABASE_SECRET_KEY is a publishable (frontend) key; use a secret key (${where})`;
  }
  const jwtRole = jwtPayloadRole(key);
  if (jwtRole === 'anon') {
    return `SUPABASE_SECRET_KEY is the anon (frontend) key; use a secret key (${where})`;
  }
  if (!key.startsWith('sb_secret_') && jwtRole !== 'service_role') {
    return `SUPABASE_SECRET_KEY must be a secret key starting with sb_secret_ or the legacy service_role key (${where})`;
  }
  return null;
}

function jwtPayloadRole(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    );
    return typeof payload?.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}
