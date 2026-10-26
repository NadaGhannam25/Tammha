/**
 * P14 — HTTP security settings (CORS, rate limiting, Swagger, proxy, JWT claims).
 * Read once at startup; invalid values stop the application with a clear message
 * (see env.validation.ts). No secret values are read or echoed here.
 */

/** JWT is signed with the shared JWT_SECRET (HMAC-SHA256). Only this algorithm is accepted. */
export const JWT_ALGORITHM = 'HS256' as const;
export const JWT_ISSUER = 'tammha-api';
export const JWT_AUDIENCE = 'tammha-app';

export const DEFAULT_RATE_LIMIT_PER_MINUTE = 300;
export const DEFAULT_AUTH_RATE_LIMIT_PER_MINUTE = 10;
export const RATE_LIMIT_WINDOW_MS = 60_000;

export interface SecuritySettings {
  nodeEnv: string;
  corsOrigins: string[];
  rateLimitEnabled: boolean;
  rateLimitPerMinute: number;
  authRateLimitPerMinute: number;
  swaggerEnabled: boolean;
  /** Value for Express `trust proxy` (false, a hop count, or a list of addresses) */
  trustProxy: boolean | number | string;
  /** P15: request header set by the hosting proxy with the real client IP (e.g. true-client-ip on Render) */
  clientIpHeader: string | null;
  errors: string[];
  /** Non-fatal configuration notes, logged at startup */
  warnings: string[];
}

type Env = Record<string, unknown>;

const read = (env: Env, key: string) =>
  typeof env[key] === 'string' ? (env[key] as string).trim() : '';

function bool(raw: string, fallback: boolean): boolean | null {
  if (!raw) return fallback;
  if (/^(true|1|yes)$/i.test(raw)) return true;
  if (/^(false|0|no)$/i.test(raw)) return false;
  return null;
}

/** CORS_ORIGINS (comma separated) + FRONTEND_ORIGIN (the production frontend). */
export function parseCorsOrigins(env: Env): string[] {
  const list = [
    read(env, 'FRONTEND_ORIGIN'),
    ...read(env, 'CORS_ORIGINS').split(','),
  ]
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return [...new Set(list)];
}

export function readSecuritySettings(env: Env): SecuritySettings {
  const errors: string[] = [];
  const warnings: string[] = [];
  const nodeEnv = read(env, 'NODE_ENV') || 'development';
  const production = nodeEnv === 'production';

  // ---- CORS ----
  let corsOrigins = parseCorsOrigins(env);
  for (const origin of corsOrigins) {
    if (origin === '*') {
      errors.push(
        'CORS_ORIGINS/FRONTEND_ORIGIN must list exact origins; "*" is not allowed',
      );
    } else if (!/^https?:\/\/[^\s/?#]+$/.test(origin)) {
      errors.push(
        `CORS origin "${origin}" must be scheme://host[:port] without a path`,
      );
    } else if (production && !origin.startsWith('https://')) {
      errors.push(
        `CORS origin "${origin}" must use https:// when NODE_ENV=production`,
      );
    }
  }
  if (production && corsOrigins.length === 0) {
    // P15: the API can be deployed before the frontend exists. No origin = no browser
    // on another site may call the API (same-origin Swagger and server-to-server calls still work).
    warnings.push(
      'FRONTEND_ORIGIN is not set: cross-origin browser requests are blocked until you set it (e.g. https://app.example.com)',
    );
  }
  if (!production && corsOrigins.length === 0) {
    corsOrigins = ['http://localhost:3000'];
  }

  // ---- Rate limiting ----
  const rateLimitEnabled = bool(read(env, 'RATE_LIMIT_ENABLED'), true);
  if (rateLimitEnabled === null) {
    errors.push('RATE_LIMIT_ENABLED must be true or false');
  } else if (production && rateLimitEnabled === false) {
    errors.push('RATE_LIMIT_ENABLED cannot be false when NODE_ENV=production');
  }
  const int = (key: string, fallback: number, min: number, max: number) => {
    const raw = read(env, key);
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      errors.push(`${key} must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return n;
  };
  const rateLimitPerMinute = int(
    'RATE_LIMIT_PER_MINUTE',
    DEFAULT_RATE_LIMIT_PER_MINUTE,
    10,
    100_000,
  );
  const authRateLimitPerMinute = int(
    'AUTH_RATE_LIMIT_PER_MINUTE',
    DEFAULT_AUTH_RATE_LIMIT_PER_MINUTE,
    1,
    1000,
  );

  // ---- Swagger: on outside production; in production only when explicitly enabled ----
  const swaggerFlag = bool(read(env, 'SWAGGER_ENABLED'), !production);
  if (swaggerFlag === null)
    errors.push('SWAGGER_ENABLED must be true or false');

  // ---- Reverse proxy (Render, Railway, Nginx...) so rate limits see the real client IP ----
  const proxyRaw = read(env, 'TRUST_PROXY');
  let trustProxy: boolean | number | string = false;
  if (proxyRaw) {
    const b = bool(proxyRaw, false);
    if (/^\d+$/.test(proxyRaw)) {
      const hops = Number(proxyRaw);
      if (hops > 10)
        errors.push('TRUST_PROXY hop count must be between 0 and 10');
      trustProxy = hops;
    } else if (b === false) {
      trustProxy = false;
    } else if (b === true) {
      errors.push(
        'TRUST_PROXY=true trusts every hop (clients could fake their IP); use a hop count such as 1',
      );
    } else if (/^[\w.:/, -]+$/.test(proxyRaw)) {
      trustProxy = proxyRaw; // e.g. "loopback" or "10.0.0.0/8"
    } else {
      errors.push(
        'TRUST_PROXY must be a hop count (e.g. 1), false, or a list of addresses',
      );
    }
  }

  // ---- P15: client IP from a header set by the platform's edge proxy ----
  const ipHeaderRaw = read(env, 'CLIENT_IP_HEADER').toLowerCase();
  let clientIpHeader: string | null = null;
  if (ipHeaderRaw) {
    if (!/^[a-z0-9-]{1,64}$/.test(ipHeaderRaw)) {
      errors.push(
        'CLIENT_IP_HEADER must be a header name such as true-client-ip',
      );
    } else if (['x-forwarded-for', 'forwarded'].includes(ipHeaderRaw)) {
      errors.push(
        'CLIENT_IP_HEADER cannot be x-forwarded-for/forwarded (clients can prepend values); use TRUST_PROXY for those',
      );
    } else {
      clientIpHeader = ipHeaderRaw;
    }
  }
  if (production && !clientIpHeader && trustProxy === false) {
    warnings.push(
      'Neither CLIENT_IP_HEADER nor TRUST_PROXY is set: behind a hosting proxy every user shares one rate-limit bucket',
    );
  }

  const publicBase = read(env, 'PUBLIC_BASE_URL');
  if (publicBase && !/^https?:\/\/[^\s/?#]+\/?$/.test(publicBase)) {
    errors.push(
      'PUBLIC_BASE_URL must be scheme://host without a path, e.g. https://api.tammha.com',
    );
  }

  // ---- bcrypt cost: tests may lower it, production must keep a safe cost ----
  const rounds = read(env, 'BCRYPT_ROUNDS');
  if (production && rounds && Number(rounds) < 10) {
    errors.push('BCRYPT_ROUNDS must be at least 10 when NODE_ENV=production');
  }

  return {
    nodeEnv,
    corsOrigins,
    rateLimitEnabled: rateLimitEnabled ?? true,
    rateLimitPerMinute,
    authRateLimitPerMinute,
    swaggerEnabled: swaggerFlag ?? false,
    trustProxy,
    clientIpHeader,
    errors,
    warnings,
  };
}
