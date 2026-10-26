import { isIP } from 'net';

interface RequestLike {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}

export interface ClientIpResult {
  ip: string;
  source: string;
}

/**
 * P15 — the client IP used for rate limiting.
 * 1. CLIENT_IP_HEADER (e.g. `true-client-ip`, set by Render's Cloudflare edge) when present
 *    and a valid IP address;
 * 2. otherwise Express `req.ip` (which honours TRUST_PROXY);
 * 3. otherwise the socket address.
 * Never reads X-Forwarded-For directly (clients can prepend values to it).
 */
export function resolveClientIp(
  req: RequestLike,
  clientIpHeader: string | null,
): ClientIpResult {
  if (clientIpHeader) {
    const raw = req.headers?.[clientIpHeader];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.split(',')[0]?.trim();
    if (value && isIP(value)) {
      return { ip: value, source: `header:${clientIpHeader}` };
    }
  }
  if (req.ip) return { ip: req.ip, source: 'req.ip' };
  return { ip: req.socket?.remoteAddress ?? 'unknown', source: 'socket' };
}
