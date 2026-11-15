import { BadRequestException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';

type Db = PrismaService | Prisma.TransactionClient;

export type StudentIdentifier =
  | { type: 'STUDENT_NUMBER'; value: string }
  | { type: 'UNIVERSITY_EMAIL'; value: string };

/**
 * Exactly one of studentNumber / universityEmail (already normalised by the DTO).
 * 400 STUDENT_IDENTIFIER_REQUIRED otherwise.
 */
export function pickStudentIdentifier(input: {
  studentNumber?: string;
  universityEmail?: string;
}): StudentIdentifier {
  const hasNumber = !!input.studentNumber;
  const hasEmail = !!input.universityEmail;
  if (hasNumber === hasEmail) {
    throw new BadRequestException({
      code: 'STUDENT_IDENTIFIER_REQUIRED',
      message: 'Provide exactly one of studentNumber or universityEmail',
    });
  }
  return hasNumber
    ? { type: 'STUDENT_NUMBER', value: input.studentNumber! }
    : { type: 'UNIVERSITY_EMAIL', value: input.universityEmail! };
}

const SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  role: true,
  isActive: true,
  universityId: true,
  studentNumber: true,
  universityEmail: true,
  universityEmailVerifiedAt: true,
  university: { select: { id: true, name: true } },
} satisfies Prisma.UserSelect;
export type FoundStudent = Prisma.UserGetPayload<{ select: typeof SELECT }>;

/**
 * An active STUDENT of the given university, found by student number or by VERIFIED
 * university e-mail (unverified/pending addresses never match). null otherwise —
 * callers answer the same 404 for every miss (no account enumeration).
 */
export async function findStudentByIdentifier(
  db: Db,
  universityId: string | null,
  identifier: StudentIdentifier,
): Promise<FoundStudent | null> {
  if (!universityId) return null;
  const row =
    identifier.type === 'STUDENT_NUMBER'
      ? await db.user.findUnique({
          where: {
            universityId_studentNumber: {
              universityId,
              studentNumber: identifier.value,
            },
          },
          select: SELECT,
        })
      : await db.user.findUnique({
          where: { universityEmail: identifier.value },
          select: SELECT,
        });
  if (
    !row ||
    row.role !== UserRole.STUDENT ||
    !row.isActive ||
    row.universityId !== universityId ||
    (identifier.type === 'UNIVERSITY_EMAIL' && !row.universityEmailVerifiedAt)
  ) {
    return null;
  }
  return row;
}
