/** Canonical form for emails: trimmed and lower-cased. */
export function normalizeEmail(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

/**
 * Case-insensitive email filter for Prisma queries.
 * New accounts are stored lower-cased; this also matches older mixed-case rows.
 */
export function emailEquals(email: string) {
  return { email: { equals: email.trim(), mode: 'insensitive' as const } };
}
