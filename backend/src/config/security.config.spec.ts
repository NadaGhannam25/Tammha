import { parseCorsOrigins, readSecuritySettings } from './security.config';
import { validateEnv } from './env.validation';
import { TEST_ENV } from '@/testing/test-env';
import {
  isNativeExecutable,
  looksLikeActiveContent,
  storageContentType,
} from '@modules/documents/document-files';
import { passwordPolicyProblem } from '@common/utils/password-policy.validator';
import { resolveClientIp } from '@common/security/client-ip';

const prod = (extra: Record<string, string> = {}) => ({
  NODE_ENV: 'production',
  FRONTEND_ORIGIN: 'https://app.tammha.sa',
  ...extra,
});

describe('security settings (P14)', () => {
  it('merges FRONTEND_ORIGIN and CORS_ORIGINS, trims slashes, removes duplicates', () => {
    expect(
      parseCorsOrigins({
        FRONTEND_ORIGIN: 'https://app.tammha.sa/',
        CORS_ORIGINS: ' http://localhost:5173 , https://app.tammha.sa,',
      }),
    ).toEqual(['https://app.tammha.sa', 'http://localhost:5173']);
  });

  it('development defaults: localhost CORS, Swagger on, rate limit on', () => {
    const s = readSecuritySettings({});
    expect(s.errors).toEqual([]);
    expect(s.corsOrigins).toEqual(['http://localhost:3000']);
    expect(s.swaggerEnabled).toBe(true);
    expect(s.rateLimitEnabled).toBe(true);
    expect(s.rateLimitPerMinute).toBe(300);
    expect(s.authRateLimitPerMinute).toBe(10);
    expect(s.trustProxy).toBe(false);
  });

  it('production: valid with an https FRONTEND_ORIGIN; Swagger off by default', () => {
    const s = readSecuritySettings(prod());
    expect(s.errors).toEqual([]);
    expect(s.swaggerEnabled).toBe(false);
    expect(
      readSecuritySettings(prod({ SWAGGER_ENABLED: 'true' })).swaggerEnabled,
    ).toBe(true);
  });

  it.each([
    [{ FRONTEND_ORIGIN: 'http://app.tammha.sa' }, 'must use https://'],
    [{ CORS_ORIGINS: '*' }, '"*" is not allowed'],
    [{ FRONTEND_ORIGIN: 'https://app.tammha.sa/path' }, 'without a path'],
    [{ RATE_LIMIT_ENABLED: 'false' }, 'RATE_LIMIT_ENABLED cannot be false'],
    [{ BCRYPT_ROUNDS: '8' }, 'BCRYPT_ROUNDS must be at least 10'],
    [{ TRUST_PROXY: 'true' }, 'TRUST_PROXY=true trusts every hop'],
    [{ TRUST_PROXY: '50' }, 'hop count must be between 0 and 10'],
    [
      { RATE_LIMIT_PER_MINUTE: '5' },
      'RATE_LIMIT_PER_MINUTE must be an integer',
    ],
    [
      { AUTH_RATE_LIMIT_PER_MINUTE: 'x' },
      'AUTH_RATE_LIMIT_PER_MINUTE must be an integer',
    ],
    [{ SWAGGER_ENABLED: 'maybe' }, 'SWAGGER_ENABLED must be true or false'],
  ])('production rejects %j', (extra, message) => {
    const errors = readSecuritySettings(prod(extra)).errors.join('\n');
    expect(errors).toContain(message);
  });

  it('TRUST_PROXY accepts a hop count or address list', () => {
    expect(readSecuritySettings({ TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(readSecuritySettings({ TRUST_PROXY: 'loopback' }).trustProxy).toBe(
      'loopback',
    );
    expect(readSecuritySettings({ TRUST_PROXY: 'false' }).trustProxy).toBe(
      false,
    );
  });

  it('P15: production starts without a frontend origin (warning, CORS closed) and errors never echo secrets', () => {
    const env = {
      ...TEST_ENV,
      NODE_ENV: 'production',
      BCRYPT_ROUNDS: '10',
      RATE_LIMIT_ENABLED: '',
      CORS_ORIGINS: '',
      FRONTEND_ORIGIN: '',
    };
    expect(() => validateEnv(env)).not.toThrow();
    const s = readSecuritySettings(env);
    expect(s.corsOrigins).toEqual([]);
    expect(s.warnings.join('\n')).toContain('FRONTEND_ORIGIN is not set');
    expect(s.warnings.join('\n')).toContain('one rate-limit bucket');

    let message = '';
    try {
      validateEnv({ ...env, CORS_ORIGINS: 'http://localhost:5173' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('must use https://');
    expect(message).not.toContain(TEST_ENV.JWT_SECRET);
    expect(message).not.toContain(TEST_ENV.SUPABASE_SECRET_KEY);
    expect(message).not.toContain('tammha_test:tammha_test');
  });

  it('P15: CLIENT_IP_HEADER and PUBLIC_BASE_URL', () => {
    expect(
      readSecuritySettings({ CLIENT_IP_HEADER: 'True-Client-IP' })
        .clientIpHeader,
    ).toBe('true-client-ip');
    expect(
      readSecuritySettings({
        CLIENT_IP_HEADER: 'x-forwarded-for',
      }).errors.join(),
    ).toContain('cannot be x-forwarded-for');
    expect(
      readSecuritySettings({ CLIENT_IP_HEADER: 'bad header!' }).errors.join(),
    ).toContain('must be a header name');
    expect(
      readSecuritySettings(prod({ CLIENT_IP_HEADER: 'true-client-ip' }))
        .warnings,
    ).toEqual([]);
    expect(
      readSecuritySettings({ PUBLIC_BASE_URL: 'https://api.tammha.com' })
        .errors,
    ).toEqual([]);
    expect(
      readSecuritySettings({
        PUBLIC_BASE_URL: 'https://api.tammha.com/api/v1',
      }).errors.join(),
    ).toContain('PUBLIC_BASE_URL');
  });
});

describe('client IP resolution (P15)', () => {
  const req = (headers: Record<string, string>, ip = '10.0.0.5') => ({
    ip,
    headers,
  });
  it('uses the configured header when it holds a valid IP', () => {
    expect(
      resolveClientIp(
        req({ 'true-client-ip': '203.0.113.7' }),
        'true-client-ip',
      ),
    ).toEqual({
      ip: '203.0.113.7',
      source: 'header:true-client-ip',
    });
    expect(
      resolveClientIp(
        req({ 'true-client-ip': '2001:db8::1' }),
        'true-client-ip',
      ).ip,
    ).toBe('2001:db8::1');
  });
  it('falls back to req.ip when the header is missing, invalid or not configured', () => {
    expect(resolveClientIp(req({}), 'true-client-ip')).toEqual({
      ip: '10.0.0.5',
      source: 'req.ip',
    });
    expect(
      resolveClientIp(req({ 'true-client-ip': 'not-an-ip' }), 'true-client-ip')
        .ip,
    ).toBe('10.0.0.5');
    expect(
      resolveClientIp(req({ 'true-client-ip': '203.0.113.7' }), null).ip,
    ).toBe('10.0.0.5');
    // X-Forwarded-For is never read directly
    expect(
      resolveClientIp(req({ 'x-forwarded-for': '1.2.3.4' }), null).ip,
    ).toBe('10.0.0.5');
  });
});

describe('password policy (P14)', () => {
  it.each([
    ['Password123', null],
    ['كلمةسر2026', null],
    [`${'a'.repeat(71)}1`, null],
    [`${'a'.repeat(72)}1`, '72 bytes'],
    [`${'ب'.repeat(36)}1`, '72 bytes'],
    ['abcdefgh', 'letter and one digit'],
    ['12345678', 'letter and one digit'],
  ])('%s', (pw, problem) => {
    const result = passwordPolicyProblem(pw);
    if (problem === null) expect(result).toBeNull();
    else expect(result).toContain(problem);
  });
});

describe('upload content sniffing (P14)', () => {
  it('detects native executables by magic bytes', () => {
    expect(isNativeExecutable(Buffer.from('MZ\x90\x00rest'))).toBe(true);
    expect(isNativeExecutable(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2]))).toBe(
      true,
    );
    expect(isNativeExecutable(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7]))).toBe(
      true,
    );
    expect(isNativeExecutable(Buffer.from('%PDF-1.7'))).toBe(false);
    expect(isNativeExecutable(Buffer.from('PK\x03\x04docx'))).toBe(false);
    expect(isNativeExecutable(Buffer.from('M'))).toBe(false);
  });

  it('neutralises HTML/SVG whatever type the client declared', () => {
    expect(looksLikeActiveContent(Buffer.from('﻿  <!doctype HTML><p>'))).toBe(
      true,
    );
    expect(looksLikeActiveContent(Buffer.from('<svg onload=alert(1)>'))).toBe(
      true,
    );
    expect(
      looksLikeActiveContent(Buffer.from('plain notes <html> later')),
    ).toBe(false);
    expect(storageContentType('text/plain', Buffer.from('<html>'))).toBe(
      'application/octet-stream',
    );
    expect(storageContentType('image/png', Buffer.from('\x89PNG'))).toBe(
      'image/png',
    );
    expect(storageContentType('text/html')).toBe('application/octet-stream');
  });
});
