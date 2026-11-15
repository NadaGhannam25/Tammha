import { readEmailVerificationRequired } from '../email-verification.config';
import { validateEnv } from '@/config/env.validation';
import { TEST_ENV } from '@/testing/test-env';

describe('EMAIL_VERIFICATION_REQUIRED', () => {
  it('follows EMAIL_ENABLED when not set', () => {
    expect(
      readEmailVerificationRequired({ EMAIL_ENABLED: 'true' }).required,
    ).toBe(true);
    expect(
      readEmailVerificationRequired({ EMAIL_ENABLED: 'false' }).required,
    ).toBe(false);
    expect(readEmailVerificationRequired({}).required).toBe(false);
  });

  it('can be set explicitly; bad values are reported', () => {
    expect(
      readEmailVerificationRequired({
        EMAIL_ENABLED: 'true',
        EMAIL_VERIFICATION_REQUIRED: 'false',
      }).required,
    ).toBe(false);
    expect(
      readEmailVerificationRequired({ EMAIL_VERIFICATION_REQUIRED: 'true' })
        .required,
    ).toBe(true);
    expect(
      readEmailVerificationRequired({
        EMAIL_VERIFICATION_REQUIRED: 'sometimes',
      }).errors,
    ).toEqual(['EMAIL_VERIFICATION_REQUIRED must be true or false']);
  });

  it('production refuses to require verification without an e-mail provider', () => {
    expect(() =>
      validateEnv({
        ...TEST_ENV,
        NODE_ENV: 'production',
        EMAIL_VERIFICATION_REQUIRED: 'true',
      }),
    ).toThrow(
      /EMAIL_VERIFICATION_REQUIRED=true needs EMAIL_ENABLED=true in production/,
    );
  });
});
