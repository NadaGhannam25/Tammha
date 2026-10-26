/**
 * Typed configuration for the external integrations (P10 — preparation only).
 *
 *  - LiveKit  (embedded meetings)        LIVEKIT_ENABLED
 *  - AI       (Gemini)                   AI_ENABLED (+ optional AI_PROVIDER=gemini)
 *  - Email    (outbox ready, no sender)  EMAIL_ENABLED must stay false
 *
 * Rules
 *  - Every integration is OFF unless its *_ENABLED flag is "true".
 *  - Variables are required ONLY for an enabled integration; a disabled one may be
 *    empty or half-filled without stopping the app.
 *  - Error messages name variables, never their values (secrets never reach logs).
 *  - Nothing here contacts a provider.
 *
 * One pure function (readIntegrationsConfig) is used both by the startup validation
 * (env.validation.ts) and at runtime (IntegrationsConfigService), so they never disagree.
 */

export type Env = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Gemini is the only AI provider (AI_PROVIDER may be omitted). */
export const AI_PROVIDERS = ['gemini'] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

export type LiveKitConfig =
  | { enabled: false }
  | {
      enabled: true;
      url: string;
      apiKey: string;
      apiSecret: string;
      /** Lifetime of a meeting join token */
      tokenTtlSeconds: number;
    };

export type AiConfig =
  | { enabled: false }
  | {
      enabled: true;
      provider: AiProviderName;
      apiKey: string;
      model: string;
      timeoutMs: number;
    };

/**
 * E-mail: the P11 outbox (email_deliveries + dispatcher) works through the EMAIL_SENDER
 * port, but no e-mail provider adapter is part of the backend. E-mail stays disabled;
 * EMAIL_ENABLED=true is refused at startup so nothing is queued that can never be sent.
 * In-app notifications do not depend on it.
 */
export type EmailConfig = { enabled: false };

export interface IntegrationsConfig {
  livekit: LiveKitConfig;
  ai: AiConfig;
  email: EmailConfig;
}

export const INTEGRATION_DEFAULTS = {
  LIVEKIT_TOKEN_TTL_SECONDS: 3600,
  AI_REQUEST_TIMEOUT_MS: 30000,
} as const;

/** Variables each provider needs once enabled (used in messages and docs). */
export const REQUIRED_VARIABLES = {
  livekit: ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'],
  ai: ['GEMINI_API_KEY', 'GEMINI_MODEL'],
} as const;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Values copied from .env.example that were never replaced. */
const PLACEHOLDER = /^(your[-_]|change[-_]?this|\[|<|xxx|todo$|replace[-_])/i;

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

export function readIntegrationsConfig(env: Env): {
  config: IntegrationsConfig;
  errors: string[];
} {
  const errors: string[] = [];
  const str = (key: string) =>
    typeof env[key] === 'string' ? (env[key] as string).trim() : '';

  const flag = (key: string): boolean => {
    const raw = str(key).toLowerCase();
    if (raw === '' || raw === 'false' || raw === '0' || raw === 'no')
      return false;
    if (raw === 'true' || raw === '1' || raw === 'yes') return true;
    errors.push(`${key} must be true or false`);
    return false;
  };

  /** Required value of an enabled integration: set and not a placeholder. */
  const required = (key: string, reason: string): string => {
    const value = str(key);
    if (!value) errors.push(`${key} is required when ${reason}`);
    else if (PLACEHOLDER.test(value))
      errors.push(`${key} still contains the .env.example placeholder`);
    return value;
  };

  const intInRange = (
    key: string,
    min: number,
    max: number,
    fallback: number,
  ): number => {
    const raw = str(key);
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      errors.push(`${key} must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return n;
  };

  // ---- LiveKit ------------------------------------------------------------
  let livekit: LiveKitConfig = { enabled: false };
  if (flag('LIVEKIT_ENABLED')) {
    const why = 'LIVEKIT_ENABLED=true';
    const url = required('LIVEKIT_URL', why);
    if (url && !PLACEHOLDER.test(url) && !isLiveKitUrl(url)) {
      errors.push(
        'LIVEKIT_URL must be the project WebSocket URL, e.g. wss://<project>.livekit.cloud',
      );
    }
    livekit = {
      enabled: true,
      url,
      apiKey: required('LIVEKIT_API_KEY', why),
      apiSecret: required('LIVEKIT_API_SECRET', why),
      tokenTtlSeconds: intInRange(
        'LIVEKIT_TOKEN_TTL_SECONDS',
        60,
        86400,
        INTEGRATION_DEFAULTS.LIVEKIT_TOKEN_TTL_SECONDS,
      ),
    };
  } else {
    intInRange('LIVEKIT_TOKEN_TTL_SECONDS', 60, 86400, 0); // format check only
  }

  // ---- AI (Gemini) ---------------------------------------------------------
  let ai: AiConfig = { enabled: false };
  const providerRaw = str('AI_PROVIDER').toLowerCase();
  if (providerRaw && !AI_PROVIDERS.includes(providerRaw as AiProviderName)) {
    errors.push('AI_PROVIDER must be gemini (the only supported AI provider)');
  }
  if (flag('AI_ENABLED')) {
    const why = 'AI_ENABLED=true';
    const apiKey = required('GEMINI_API_KEY', why);
    const model = required('GEMINI_MODEL', why);
    if (model && !PLACEHOLDER.test(model) && !MODEL_ID.test(model)) {
      errors.push(
        "GEMINI_MODEL must be a model ID from Google AI Studio's models page (letters, digits, . _ - : /)",
      );
    }
    ai = {
      enabled: true,
      provider: 'gemini',
      apiKey,
      model,
      timeoutMs: intInRange(
        'AI_REQUEST_TIMEOUT_MS',
        1000,
        120000,
        INTEGRATION_DEFAULTS.AI_REQUEST_TIMEOUT_MS,
      ),
    };
  } else {
    intInRange('AI_REQUEST_TIMEOUT_MS', 1000, 120000, 0); // format check only
  }

  // ---- Email (no provider adapter in this backend) ------------------------
  const email: EmailConfig = { enabled: false };
  if (flag('EMAIL_ENABLED')) {
    errors.push(
      'EMAIL_ENABLED=true is not supported: no e-mail provider is implemented. Keep EMAIL_ENABLED=false (in-app notifications work without it)',
    );
  }

  return { config: { livekit, ai, email }, errors };
}

function isLiveKitUrl(url: string): boolean {
  if (/^wss:\/\/[^\s/]+\/?$/.test(url)) return true;
  if (/^https:\/\/[^\s/]+\/?$/.test(url)) return true; // SDKs accept https too
  // self-hosted LiveKit on this machine during development
  return /^wss?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(url);
}
