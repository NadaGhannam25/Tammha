import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  const valid = {
    NODE_ENV: 'development',
    DATABASE_URL:
      'postgresql://postgres.fakeref:not-a-real-password@aws-0-eu.pooler.supabase.com:6543/postgres?pgbouncer=true',
    JWT_SECRET: 'a'.repeat(32),
    // Required since P07 (documents in Supabase Storage). Fake values.
    SUPABASE_URL: 'https://fakeref.supabase.co',
    SUPABASE_SECRET_KEY: 'sb_secret_fake-not-a-real-key-0123456789',
  };

  it('accepts a minimal valid configuration', () => {
    expect(validateEnv(valid)).toBe(valid);
  });

  it.each([
    ['missing DATABASE_URL', { DATABASE_URL: undefined }, 'DATABASE_URL'],
    [
      'non-postgres DATABASE_URL',
      { DATABASE_URL: 'mysql://x' },
      'DATABASE_URL',
    ],
    [
      'placeholder DATABASE_URL',
      {
        DATABASE_URL:
          'postgresql://postgres.[PROJECT_REF]:[PASSWORD]@host:6543/postgres',
      },
      'placeholders',
    ],
    ['short JWT_SECRET', { JWT_SECRET: 'short' }, 'JWT_SECRET'],
    ['bad BCRYPT_ROUNDS', { BCRYPT_ROUNDS: '50' }, 'BCRYPT_ROUNDS'],
    ['bad PORT', { PORT: 'abc' }, 'PORT'],
    ['bad TEAM_MAX_MEMBERS', { TEAM_MAX_MEMBERS: '0' }, 'TEAM_MAX_MEMBERS'],
    ['bad JWT_EXPIRATION', { JWT_EXPIRATION: 'one hour' }, 'JWT_EXPIRATION'],
    [
      'bad INVITATION_LINK_BASE_URL',
      { INVITATION_LINK_BASE_URL: 'app/join' },
      'INVITATION',
    ],
    ['bad NODE_ENV', { NODE_ENV: 'staging' }, 'NODE_ENV'],
  ])('rejects %s', (_label, patch, expected) => {
    expect(() => validateEnv({ ...valid, ...patch })).toThrow(expected);
  });

  it('rejects the example JWT_SECRET in production only', () => {
    const example = {
      JWT_SECRET: 'your-secret-key-min-32-characters-change-this-in-production',
    };
    expect(() => validateEnv({ ...valid, ...example })).not.toThrow();
    expect(() =>
      validateEnv({ ...valid, ...example, NODE_ENV: 'production' }),
    ).toThrow('JWT_SECRET');
  });

  it('treats empty optional values as unset', () => {
    expect(() =>
      validateEnv({ ...valid, TEAM_MAX_MEMBERS: '', PORT: '' }),
    ).not.toThrow();
  });

  describe('REQUIRED_DOCUMENT_CATEGORIES (P09, optional)', () => {
    it('accepts unset, empty and valid lists', () => {
      expect(() => validateEnv({ ...valid })).not.toThrow();
      expect(() =>
        validateEnv({ ...valid, REQUIRED_DOCUMENT_CATEGORIES: '' }),
      ).not.toThrow();
      expect(() =>
        validateEnv({ ...valid, REQUIRED_DOCUMENT_CATEGORIES: 'report, CODE' }),
      ).not.toThrow();
    });

    it('rejects unknown categories at startup', () => {
      expect(() =>
        validateEnv({
          ...valid,
          REQUIRED_DOCUMENT_CATEGORIES: 'REPORT,THESIS',
        }),
      ).toThrow(/REQUIRED_DOCUMENT_CATEGORIES must be a comma-separated list/);
    });
  });

  describe('Supabase Storage (P07)', () => {
    const fakeJwt = (role: string) =>
      [
        Buffer.from('{"alg":"HS256"}').toString('base64url'),
        Buffer.from(JSON.stringify({ role, iss: 'supabase' })).toString(
          'base64url',
        ),
        'signature',
      ].join('.');

    it.each([
      [
        'missing SUPABASE_URL',
        { SUPABASE_URL: undefined },
        'SUPABASE_URL must be set',
      ],
      [
        'non-https SUPABASE_URL',
        { SUPABASE_URL: 'ftp://x.supabase.co' },
        'SUPABASE_URL must be',
      ],
      [
        'placeholder SUPABASE_URL',
        { SUPABASE_URL: 'https://your-project.supabase.co' },
        'placeholder',
      ],
      [
        'missing SUPABASE_SECRET_KEY',
        { SUPABASE_SECRET_KEY: undefined },
        'SUPABASE_SECRET_KEY must be set',
      ],
      [
        'placeholder secret key',
        { SUPABASE_SECRET_KEY: 'your-service-role-key-keep-secret' },
        'placeholder',
      ],
      [
        'publishable key used as secret',
        { SUPABASE_SECRET_KEY: 'sb_publishable_abc123def456ghi789' },
        'publishable',
      ],
      [
        'legacy anon JWT used as secret',
        { SUPABASE_SECRET_KEY: fakeJwt('anon') },
        'anon',
      ],
      [
        'unknown key format',
        { SUPABASE_SECRET_KEY: 'just-some-random-string-1234567890' },
        'sb_secret_',
      ],
    ])('rejects %s', (_label, patch, expected) => {
      expect(() => validateEnv({ ...valid, ...patch })).toThrow(expected);
    });

    it('accepts a secret key and the legacy service_role key', () => {
      expect(() => validateEnv(valid)).not.toThrow();
      expect(() =>
        validateEnv({ ...valid, SUPABASE_SECRET_KEY: fakeJwt('service_role') }),
      ).not.toThrow();
    });

    it('never includes the key value in the error message', () => {
      const leaked = 'sb_publishable_THIS-VALUE-MUST-NOT-APPEAR-IN-ERRORS';
      try {
        validateEnv({ ...valid, SUPABASE_SECRET_KEY: leaked });
        throw new Error('expected validation to fail');
      } catch (error) {
        expect((error as Error).message).not.toContain(
          'THIS-VALUE-MUST-NOT-APPEAR',
        );
      }
    });
  });
});
