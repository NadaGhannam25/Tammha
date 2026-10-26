import { SetMetadata } from '@nestjs/common';

export const STRICT_RATE_LIMIT_KEY = 'tammha:strictRateLimit';

/**
 * Applies the strict per-IP limit (AUTH_RATE_LIMIT_PER_MINUTE, default 10/min) on top of
 * the global one. Used on endpoints that accept guessable secrets: login, register,
 * token refresh, invitation join/preview.
 */
export const StrictRateLimit = () => SetMetadata(STRICT_RATE_LIMIT_KEY, true);
