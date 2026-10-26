import { SafeUser } from '@modules/users/user.mapper';

/**
 * The authenticated user attached to request.user by JwtStrategy.
 * Loaded fresh from the database on every request; never contains the password hash.
 */
export type AuthUser = SafeUser;

export interface AuthenticatedRequest {
  user: AuthUser;
}
