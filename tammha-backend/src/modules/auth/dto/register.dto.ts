import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { NormalizeEmail } from '@common/utils/normalize-email.transform';
import { Trim } from '@common/utils/trim.transform';
import { IsStrongPassword } from '@common/utils/password-policy.validator';
import {
  NormalizeStudentNumber,
  STUDENT_NUMBER_PATTERN,
} from '@common/utils/student-number';

/** Accepted by validation; SUPERVISOR is then refused with a clear 403 code. */
export const REGISTRABLE_ROLES = [UserRole.STUDENT, UserRole.SUPERVISOR];

export class RegisterDto {
  @ApiProperty({
    description: 'User email address (unique, stored lower-case)',
    example: 'student@university.edu',
  })
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({
    description:
      'User password: 8-128 characters, at most 72 bytes (bcrypt limit), at least one letter and one digit',
    example: 'SecurePassword123',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @IsStrongPassword()
  password!: string;

  @ApiPropertyOptional({ description: 'User first name', example: 'Ahmed' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(128)
  firstName?: string;

  @ApiPropertyOptional({ description: 'User last name', example: 'Al-Rashid' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(128)
  lastName?: string;

  @ApiPropertyOptional({
    description:
      'Optional: STUDENT (default) or SUPERVISOR. A SUPERVISOR registers with a university e-mail ' +
      'of the selected university (400 SUPERVISOR_UNIVERSITY_EMAIL_REQUIRED otherwise), needs no ' +
      'student number, and is offered to students only after verifying that e-mail.',
    enum: REGISTRABLE_ROLES,
    example: UserRole.STUDENT,
  })
  @IsOptional()
  @IsIn(REGISTRABLE_ROLES, { message: 'role must be STUDENT or SUPERVISOR' })
  role?: UserRole;

  @ApiPropertyOptional({
    description: 'Preferred interface and email language (default: ar)',
    enum: ['ar', 'en'],
    example: 'ar',
  })
  @IsOptional()
  @IsIn(['ar', 'en'])
  preferredLanguage?: 'ar' | 'en';

  @ApiProperty({
    description: 'ID of an active university (see GET /universities)',
    example: 'clvt7xyz9k000abcdef1g',
  })
  @Trim()
  @IsString()
  @IsNotEmpty()
  universityId!: string;

  @ApiProperty({
    description:
      'REQUIRED: university student ID / number (3-20 letters/digits/dashes, stored upper-case, unique within the university; ' +
      'missing → 400 STUDENT_NUMBER_REQUIRED). Teammates use it to invite the student.',
    example: '2026001234',
  })
  @IsOptional()
  @NormalizeStudentNumber()
  @IsString()
  @Matches(STUDENT_NUMBER_PATTERN, {
    message: 'studentNumber must be 3-20 letters, digits or dashes',
  })
  studentNumber?: string;

  @ApiPropertyOptional({
    description:
      'University e-mail, when it is NOT the account e-mail. A university e-mail is required ' +
      '(400 UNIVERSITY_EMAIL_REQUIRED): the account `email` on the university domain (or flagged with ' +
      'accountEmailIsUniversityEmail), or this field. Full access starts after it is verified ' +
      '(when it is also the account e-mail, verifying the account e-mail verifies both). Must belong ' +
      "to the university's e-mail domains when configured; personal providers (gmail.com …) are never accepted. Unique.",
    example: 'n.alharbi@um.edu.sa',
  })
  @IsOptional()
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  universityEmail?: string;

  @ApiPropertyOptional({
    description:
      'STUDENT only: true = the account `email` IS the university e-mail (no second address needed). ' +
      "Also detected automatically when the account e-mail matches the university's configured domains.",
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  accountEmailIsUniversityEmail?: boolean;
}
