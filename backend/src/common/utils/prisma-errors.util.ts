/**
 * True when a Prisma call failed on a unique constraint (P2002).
 * Works with PrismaClientKnownRequestError without importing runtime internals.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
