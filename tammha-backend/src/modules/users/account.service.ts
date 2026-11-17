import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuthUser } from '@common/types/auth-user.type';
import { isUniqueConstraintError } from '@common/utils/prisma-errors.util';
import {
  identityMissingAtInput,
  universityIdentityOf,
} from '@common/identity/university-identity';
import {
  maskEmail,
  maskStudentNumber,
} from '@common/identity/university-email';
import {
  findStudentByIdentifier,
  pickStudentIdentifier,
} from '@common/identity/student-lookup';
import { SafeUser, toSafeUser } from './user.mapper';
import {
  OnboardingStateDto,
  StudentSearchQueryDto,
  StudentSearchResultDto,
  UpdateMyProfileDto,
} from './dto/account.dto';

/** "Nada A." — enough to recognise a classmate, without the full surname or e-mail. */
export function displayName(first: string | null, last: string | null) {
  const f = (first ?? '').trim();
  const l = (last ?? '').trim();
  if (!f && !l) return 'Student';
  return l ? `${f || l}${f ? ` ${l[0].toUpperCase()}.` : ''}` : f;
}

/**
 * P16: the signed-in user's own account (profile, student number, onboarding)
 * and the student-number lookup used to invite teammates.
 */
@Injectable()
export class AccountService {
  constructor(private readonly prisma: PrismaService) {}

  async updateMyProfile(
    user: AuthUser,
    dto: UpdateMyProfileDto,
  ): Promise<SafeUser> {
    if (dto.studentNumber !== undefined && user.role !== UserRole.STUDENT) {
      throw new BadRequestException({
        code: 'STUDENT_NUMBER_NOT_ALLOWED',
        message: 'Only STUDENT accounts have a student number',
      });
    }
    // a STUDENT must keep a student number or a verified university e-mail
    if (
      dto.studentNumber === null &&
      user.role === UserRole.STUDENT &&
      !universityIdentityOf({ ...user, studentNumber: null }).complete
    ) {
      throw identityMissingAtInput();
    }
    const data: Prisma.UserUpdateInput = {};
    if (dto.firstName !== undefined) data.firstName = dto.firstName;
    if (dto.lastName !== undefined) data.lastName = dto.lastName;
    if (dto.bio !== undefined) data.bio = dto.bio || null;
    if (dto.college !== undefined) data.college = dto.college || null;
    if (dto.major !== undefined) data.major = dto.major || null;
    if (dto.avatar !== undefined) data.avatar = dto.avatar || null;
    if (dto.preferredLanguage !== undefined)
      data.preferredLanguage = dto.preferredLanguage;
    if (dto.studentNumber !== undefined) data.studentNumber = dto.studentNumber;
    try {
      const row = await this.prisma.user.update({
        where: { id: user.id },
        data,
      });
      return toSafeUser(row);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException({
          code: 'STUDENT_NUMBER_TAKEN',
          message:
            'This student number is already registered at this university',
        });
      }
      throw error;
    }
  }

  /** Idempotent: the first completion time is kept. */
  async completeOnboarding(user: AuthUser): Promise<OnboardingStateDto> {
    await this.prisma.user.updateMany({
      where: { id: user.id, onboardingCompletedAt: null },
      data: { onboardingCompletedAt: new Date() },
    });
    const row = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { onboardingCompletedAt: true },
    });
    return {
      onboardingCompleted: true,
      onboardingCompletedAt: row!.onboardingCompletedAt!,
    };
  }

  /**
   * Exact lookup inside the caller's university by student number OR verified university
   * e-mail. Returns safe invitation info only: display name, university, which identifier
   * matched (masked) and availability — never the user id, account e-mail or full
   * identifiers. Unknown identifiers, other universities, unverified e-mails, inactive
   * accounts and non-students all give the same 404.
   */
  async searchStudent(
    user: AuthUser,
    query: StudentSearchQueryDto,
  ): Promise<StudentSearchResultDto> {
    const identifier = pickStudentIdentifier(query);
    const student = await findStudentByIdentifier(
      this.prisma,
      user.universityId,
      identifier,
    );
    if (!student || !student.university) {
      throw new NotFoundException({
        code: 'STUDENT_NOT_FOUND',
        message: 'No student with this identifier was found at your university',
      });
    }

    // Students can be in several teams, so availability is relative to ONE team: the
    // given teamId (one of the caller's teams), else any team the caller is in.
    let availability: StudentSearchResultDto['availability'] = 'AVAILABLE';
    if (student.id === user.id) {
      availability = 'YOU';
    } else {
      const mine = await this.prisma.teamMember.findMany({
        where: {
          userId: user.id,
          ...(query.teamId ? { teamId: query.teamId } : {}),
        },
        select: { teamId: true },
      });
      const shared = await this.prisma.teamMember.count({
        where: {
          userId: student.id,
          teamId: { in: mine.map((m) => m.teamId) },
        },
      });
      if (shared > 0) availability = 'IN_YOUR_TEAM';
    }
    return {
      displayName: displayName(student.firstName, student.lastName),
      matchedBy: identifier.type,
      maskedIdentifier:
        identifier.type === 'STUDENT_NUMBER'
          ? maskStudentNumber(identifier.value)
          : maskEmail(identifier.value),
      university: student.university,
      availability,
    };
  }
}
