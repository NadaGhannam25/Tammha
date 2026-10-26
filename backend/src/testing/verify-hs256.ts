import { createHmac, timingSafeEqual } from 'crypto';

/**
 * TEST-ONLY: verifies an HS256 JWT with Node's crypto and returns its claims.
 * Throws when the signature does not match the secret.
 */
export function verifyHs256(
  token: string,
  secret: string,
): Record<string, any> {
  const [header, payload, signature] = token.split('.');
  const expected = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  const a = Buffer.from(signature ?? '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('invalid signature');
  }
  const alg = JSON.parse(Buffer.from(header, 'base64url').toString()).alg;
  if (alg !== 'HS256') throw new Error(`unexpected alg ${alg}`);
  return JSON.parse(Buffer.from(payload, 'base64url').toString());
}
