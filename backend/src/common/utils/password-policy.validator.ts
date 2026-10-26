import { ValidationOptions, registerDecorator } from 'class-validator';

/** bcrypt only uses the first 72 BYTES of a password; longer input would be silently cut. */
export const BCRYPT_MAX_PASSWORD_BYTES = 72;

/**
 * Password policy for new passwords (registration):
 * - at most 72 UTF-8 bytes (bcrypt limit; Arabic letters take 2 bytes each)
 * - at least one letter and one digit
 * Length 8..128 characters is checked separately with MinLength/MaxLength.
 */
export function IsStrongPassword(options?: ValidationOptions) {
  return function (target: object, propertyName: string) {
    registerDecorator({
      name: 'isStrongPassword',
      target: target.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown) {
          return (
            typeof value === 'string' && passwordPolicyProblem(value) === null
          );
        },
        defaultMessage(args) {
          const value = args?.value;
          return typeof value === 'string'
            ? (passwordPolicyProblem(value) ?? 'password is invalid')
            : 'password must be a string';
        },
      },
    });
  };
}

export function passwordPolicyProblem(value: string): string | null {
  if (Buffer.byteLength(value, 'utf8') > BCRYPT_MAX_PASSWORD_BYTES) {
    return `password must be at most ${BCRYPT_MAX_PASSWORD_BYTES} bytes (bcrypt limit)`;
  }
  if (!/\p{L}/u.test(value) || !/\p{Nd}/u.test(value)) {
    return 'password must contain at least one letter and one digit';
  }
  return null;
}
