import { UserRole } from '@prisma/client';

export interface JwtPayload {
  /**
   * User ID (subject)
   */
  sub: string;

  /**
   * User email
   */
  email: string;

  /**
   * User role (STUDENT, SUPERVISOR, or ADMIN)
   */
  role: UserRole;

  /**
   * Issued at timestamp (added by JWT library)
   */
  iat?: number;

  /**
   * Expiration timestamp (added by JWT library)
   */
  exp?: number;
}
