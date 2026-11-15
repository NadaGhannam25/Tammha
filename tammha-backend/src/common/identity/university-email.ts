/** "@Um.Edu.Sa" / ".um.edu.sa" / "um.edu.sa" -> "um.edu.sa" */
export function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^[@.]+/, '');
}

/** Personal mailbox providers: never accepted as a university e-mail. */
export const PERSONAL_EMAIL_DOMAINS = [
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'outlook.com',
  'outlook.sa',
  'live.com',
  'msn.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'mail.com',
  'yandex.com',
];

/**
 * True when the e-mail's domain equals a configured university domain or is one of its
 * subdomains (student.um.edu.sa matches um.edu.sa). When the university has no domains
 * configured yet (`npm run university:create -- ... --email-domains a,b`), any address
 * except a personal mailbox provider (gmail.com, outlook.com …) is accepted; it must
 * still be verified.
 */
export function emailDomainAllowed(
  email: string,
  domains: string[] | null | undefined,
): boolean {
  const configured = (domains ?? []).map(normalizeDomain).filter(Boolean);
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = normalizeDomain(email.slice(at + 1));
  if (configured.length === 0) return !PERSONAL_EMAIL_DOMAINS.includes(domain);
  return configured.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** True when domains are configured and the e-mail matches one of them. */
export function emailMatchesConfiguredDomain(
  email: string,
  domains: string[] | null | undefined,
): boolean {
  return (domains ?? []).some(Boolean) && emailDomainAllowed(email, domains);
}

/** "n***@um.edu.sa" */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

/** "20****34" — keeps 2 characters at each end (less for short numbers). */
export function maskStudentNumber(value: string): string {
  if (value.length <= 4) return `${value[0]}${'*'.repeat(value.length - 1)}`;
  return `${value.slice(0, 2)}${'*'.repeat(value.length - 4)}${value.slice(-2)}`;
}
