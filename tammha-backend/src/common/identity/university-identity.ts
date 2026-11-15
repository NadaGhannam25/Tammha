import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';

/**
 * University identity of a STUDENT: a student number of their university OR a VERIFIED
 * university e-mail. One is enough; neither = profile incomplete.
 *
 * SUPERVISOR and ADMIN accounts are never asked for one. The internal user id is never
 * an identifier students type or share.
 */
export const UNIVERSITY_IDENTITY_REQUIRED = 'UNIVERSITY_IDENTITY_REQUIRED';

export type UniversityIdentityMethod = 'STUDENT_NUMBER' | 'UNIVERSITY_EMAIL';

export interface IdentityFields {
  role: UserRole | string;
  universityId: string | null;
  studentNumber?: string | null;
  universityEmail?: string | null;
  universityEmailVerifiedAt?: Date | null;
  pendingUniversityEmail?: string | null;
}

export interface UniversityIdentityState {
  /** true for STUDENT accounts only */
  required: boolean;
  /** not required, or at least one identifier is satisfied */
  complete: boolean;
  /** identifiers that currently satisfy the rule */
  satisfiedBy: UniversityIdentityMethod[];
  studentNumber: string | null;
  /** verified university e-mail (never an unverified one) */
  universityEmail: string | null;
  universityEmailVerified: boolean;
  /** requested university e-mail waiting for its verification link */
  pendingUniversityEmail: string | null;
}

export function universityIdentityOf(
  user: IdentityFields,
): UniversityIdentityState {
  const required = user.role === UserRole.STUDENT;
  const satisfiedBy: UniversityIdentityMethod[] = [];
  if (user.studentNumber && user.universityId)
    satisfiedBy.push('STUDENT_NUMBER');
  const emailVerified =
    !!user.universityEmail && !!user.universityEmailVerifiedAt;
  if (emailVerified) satisfiedBy.push('UNIVERSITY_EMAIL');
  return {
    required,
    complete: !required || satisfiedBy.length > 0,
    satisfiedBy,
    studentNumber: user.studentNumber ?? null,
    universityEmail: emailVerified ? user.universityEmail! : null,
    universityEmailVerified: emailVerified,
    pendingUniversityEmail: user.pendingUniversityEmail ?? null,
  };
}

export function hasUniversityIdentity(user: IdentityFields): boolean {
  return universityIdentityOf(user).complete;
}

const identityBody = (message: string) => ({
  code: UNIVERSITY_IDENTITY_REQUIRED,
  message,
  details: {
    missing: ['UNIVERSITY_IDENTITY'],
    acceptedIdentifiers: ['studentNumber', 'verifiedUniversityEmail'],
  },
});

/**
 * 403 UNIVERSITY_IDENTITY_REQUIRED for a STUDENT without a student number and without
 * a verified university e-mail (create a project, lead/manage a team, complete setup).
 */
export function assertUniversityIdentity(user: IdentityFields) {
  if (hasUniversityIdentity(user)) return;
  throw new ForbiddenException(
    identityBody(
      'Add your university student number or verify your university e-mail first.',
    ),
  );
}

/** 400 at registration / profile update: a STUDENT must keep at least one identifier. */
export function identityMissingAtInput() {
  return new BadRequestException(
    identityBody(
      'Students must provide a university student number or a university e-mail.',
    ),
  );
}

/** 409 when another student would become leader without a university identity. */
export function targetIdentityMissing() {
  return new ConflictException(
    identityBody(
      'This student has no student number or verified university e-mail yet and cannot become the team leader.',
    ),
  );
}
