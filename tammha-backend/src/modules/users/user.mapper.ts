import { User } from '@prisma/client';
import {
  UniversityIdentityState,
  universityIdentityOf,
} from '@common/identity/university-identity';

/**
 * A user record without the password hash, plus derived flags the frontend needs after
 * login: whether the e-mail is verified, whether onboarding is done, and the university
 * identity of a STUDENT (student number or verified university e-mail).
 */
export type SafeUser = Omit<User, 'password'> & {
  emailVerified: boolean;
  onboardingCompleted: boolean;
  universityIdentity: UniversityIdentityState;
  /** false for a STUDENT without a student number and without a verified university e-mail */
  profileComplete: boolean;
};

/** Removes the password hash before a user leaves the service layer. */
export function toSafeUser(user: User): SafeUser {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { password, ...safe } = user;
  const base = {
    ...safe,
    studentNumber: safe.studentNumber ?? null,
    universityEmail: safe.universityEmail ?? null,
    universityEmailVerifiedAt: safe.universityEmailVerifiedAt ?? null,
    pendingUniversityEmail: safe.pendingUniversityEmail ?? null,
    emailVerifiedAt: safe.emailVerifiedAt ?? null,
    onboardingCompletedAt: safe.onboardingCompletedAt ?? null,
  };
  const universityIdentity = universityIdentityOf(base);
  return {
    ...base,
    emailVerified: !!base.emailVerifiedAt,
    onboardingCompleted: !!base.onboardingCompletedAt,
    universityIdentity,
    profileComplete: universityIdentity.complete,
  };
}
