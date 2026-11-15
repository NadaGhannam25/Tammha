/**
 * Whether the signed-in product flow requires a verified account e-mail.
 *
 * EMAIL_VERIFICATION_REQUIRED=true|false; when empty it follows EMAIL_ENABLED (a real
 * e-mail provider exists => verification is required). It cannot be true in production
 * while e-mail delivery is off: nobody could receive the link.
 */
export function readEmailVerificationRequired(env: Record<string, unknown>): {
  required: boolean;
  errors: string[];
} {
  const str = (k: string) =>
    typeof env[k] === 'string' ? (env[k] as string).trim().toLowerCase() : '';
  const truthy = (v: string) => ['true', '1', 'yes'].includes(v);
  const errors: string[] = [];
  const raw = str('EMAIL_VERIFICATION_REQUIRED');
  const emailEnabled = truthy(str('EMAIL_ENABLED'));
  let required = emailEnabled;
  if (raw) {
    if (truthy(raw)) required = true;
    else if (['false', '0', 'no'].includes(raw)) required = false;
    else errors.push('EMAIL_VERIFICATION_REQUIRED must be true or false');
  }
  if (required && !emailEnabled && str('NODE_ENV') === 'production') {
    errors.push(
      'EMAIL_VERIFICATION_REQUIRED=true needs EMAIL_ENABLED=true in production (otherwise no one can verify)',
    );
  }
  return { required, errors };
}
