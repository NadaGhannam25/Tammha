import { readIntegrationsConfig } from '../integrations.config';
import { validateEnv } from '@/config/env.validation';
import { TEST_ENV } from '@/testing/test-env';

const read = (env: Record<string, string>) => readIntegrationsConfig(env);

const LIVEKIT = {
  LIVEKIT_ENABLED: 'true',
  LIVEKIT_URL: 'wss://tammha-demo.livekit.cloud',
  LIVEKIT_API_KEY: 'APIdemoKey123',
  LIVEKIT_API_SECRET: 'super-secret-livekit-value-123',
};

describe('Integrations configuration (P10)', () => {
  describe('everything is OFF by default', () => {
    it('no variables -> all disabled, no errors', () => {
      const { config, errors } = read({});
      expect(errors).toEqual([]);
      expect(config).toEqual({
        livekit: { enabled: false },
        ai: { enabled: false },
        email: { enabled: false },
      });
    });

    it('half-filled variables of a disabled integration are ignored', () => {
      const { config, errors } = read({
        LIVEKIT_ENABLED: 'false',
        LIVEKIT_URL: 'not-a-url',
        AI_ENABLED: '',
        GEMINI_MODEL: '???',
        EMAIL_ENABLED: '0',
      });
      expect(errors).toEqual([]);
      expect(config.livekit.enabled).toBe(false);
    });

    it('flags accept true/false/1/0/yes/no (case-insensitive) and reject anything else', () => {
      expect(read({ LIVEKIT_ENABLED: 'FALSE' }).errors).toEqual([]);
      expect(read({ AI_ENABLED: 'maybe' }).errors).toEqual([
        'AI_ENABLED must be true or false',
      ]);
    });
  });

  describe('LiveKit', () => {
    it('enabled without variables names every missing one', () => {
      expect(read({ LIVEKIT_ENABLED: 'true' }).errors).toEqual([
        'LIVEKIT_URL is required when LIVEKIT_ENABLED=true',
        'LIVEKIT_API_KEY is required when LIVEKIT_ENABLED=true',
        'LIVEKIT_API_SECRET is required when LIVEKIT_ENABLED=true',
      ]);
    });

    it('valid configuration is typed, with the default token lifetime', () => {
      const { config, errors } = read(LIVEKIT);
      expect(errors).toEqual([]);
      expect(config.livekit).toEqual({
        enabled: true,
        url: 'wss://tammha-demo.livekit.cloud',
        apiKey: 'APIdemoKey123',
        apiSecret: 'super-secret-livekit-value-123',
        tokenTtlSeconds: 3600,
      });
    });

    it.each([
      ['wss://x.livekit.cloud', true],
      ['https://x.livekit.cloud', true],
      ['ws://localhost:7880', true],
      ['ws://x.livekit.cloud', false], // unencrypted outside localhost
      ['x.livekit.cloud', false],
      ['wss://x.livekit.cloud/rooms/a', false],
    ])('LIVEKIT_URL %s valid=%s', (url, ok) => {
      const { errors } = read({ ...LIVEKIT, LIVEKIT_URL: url });
      expect(errors.length === 0).toBe(ok);
    });

    it('placeholders and token lifetime bounds', () => {
      expect(
        read({ ...LIVEKIT, LIVEKIT_API_SECRET: 'your-livekit-secret' }).errors,
      ).toEqual([
        'LIVEKIT_API_SECRET still contains the .env.example placeholder',
      ]);
      expect(
        read({ ...LIVEKIT, LIVEKIT_TOKEN_TTL_SECONDS: '30' }).errors,
      ).toEqual([
        'LIVEKIT_TOKEN_TTL_SECONDS must be an integer between 60 and 86400',
      ]);
      const ok = read({ ...LIVEKIT, LIVEKIT_TOKEN_TTL_SECONDS: '7200' }).config;
      expect(ok.livekit.enabled && ok.livekit.tokenTtlSeconds).toBe(7200);
    });
  });

  describe('AI (Gemini only)', () => {
    it('enabled requires GEMINI_API_KEY and GEMINI_MODEL; AI_PROVIDER is optional', () => {
      expect(read({ AI_ENABLED: 'true' }).errors).toEqual([
        'GEMINI_API_KEY is required when AI_ENABLED=true',
        'GEMINI_MODEL is required when AI_ENABLED=true',
      ]);
      const { config, errors } = read({
        AI_ENABLED: 'true',
        GEMINI_API_KEY: 'AIza-test',
        GEMINI_MODEL: 'models/some-gemini-id',
        AI_REQUEST_TIMEOUT_MS: '15000',
      });
      expect(errors).toEqual([]);
      expect(config.ai).toEqual({
        enabled: true,
        provider: 'gemini',
        apiKey: 'AIza-test',
        model: 'models/some-gemini-id',
        timeoutMs: 15000,
      });
      expect(
        read({
          AI_ENABLED: 'true',
          AI_PROVIDER: 'Gemini',
          GEMINI_API_KEY: 'k',
          GEMINI_MODEL: 'm',
        }).errors,
      ).toEqual([]);
    });

    it.each(['openai', 'mock', 'claude', 'gemni'])(
      'AI_PROVIDER=%s is rejected (Gemini is the only provider), even while disabled',
      (provider) => {
        expect(read({ AI_PROVIDER: provider }).errors).toEqual([
          'AI_PROVIDER must be gemini (the only supported AI provider)',
        ]);
      },
    );

    it('rejects malformed model IDs and timeouts', () => {
      const base = { AI_ENABLED: 'true', GEMINI_API_KEY: 'k' };
      expect(read({ ...base, GEMINI_MODEL: 'my model' }).errors[0]).toMatch(
        /GEMINI_MODEL must be a model ID/,
      );
      expect(
        read({ ...base, GEMINI_MODEL: 'm', AI_REQUEST_TIMEOUT_MS: '10' })
          .errors,
      ).toEqual([
        'AI_REQUEST_TIMEOUT_MS must be an integer between 1000 and 120000',
      ]);
    });
  });

  describe('Email (no provider in this backend)', () => {
    it('stays disabled; EMAIL_ENABLED=true is refused with a clear message', () => {
      expect(read({ EMAIL_ENABLED: 'false' }).config.email).toEqual({
        enabled: false,
      });
      expect(read({ EMAIL_ENABLED: 'true' }).errors).toEqual([
        'EMAIL_ENABLED=true is not supported: no e-mail provider is implemented. Keep EMAIL_ENABLED=false (in-app notifications work without it)',
      ]);
    });
  });

  describe('secrets never appear in messages', () => {
    it('errors name variables only', () => {
      const secrets = {
        LIVEKIT_API_SECRET: 'LK-SECRET-9f8e7d',
        GEMINI_API_KEY: 'AIza-SECRET-1a2b3c',
      };
      const { errors } = read({
        ...secrets,
        LIVEKIT_ENABLED: 'true',
        LIVEKIT_URL: 'bad',
        AI_ENABLED: 'true',
        GEMINI_MODEL: 'bad model',
        EMAIL_ENABLED: 'true',
      });
      expect(errors.length).toBeGreaterThanOrEqual(3);
      const text = errors.join('\n');
      for (const value of Object.values(secrets))
        expect(text).not.toContain(value);
    });
  });

  describe('startup validation (validateEnv)', () => {
    const base = { ...TEST_ENV } as Record<string, string>;

    it('the default test configuration starts with every integration off', () => {
      expect(() => validateEnv(base)).not.toThrow();
    });

    it('an enabled integration with missing variables stops the app with their names', () => {
      expect(() => validateEnv({ ...base, LIVEKIT_ENABLED: 'true' })).toThrow(
        /LIVEKIT_URL is required[\s\S]*LIVEKIT_API_KEY is required[\s\S]*LIVEKIT_API_SECRET is required/,
      );
      expect(() =>
        validateEnv({ ...base, AI_ENABLED: 'true', AI_PROVIDER: 'gemini' }),
      ).toThrow(/GEMINI_API_KEY is required/);
    });

    it('a complete integration configuration passes', () => {
      expect(() => validateEnv({ ...base, ...LIVEKIT })).not.toThrow();
    });
  });
});
