import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { NormalizeEmail } from '@common/utils/normalize-email.transform';
import { Trim } from '@common/utils/trim.transform';
import {
  NormalizeStudentNumber,
  STUDENT_NUMBER_PATTERN,
} from '@common/utils/student-number';

/** Longest stored profile photo (a 256 px JPEG is about 20-40 KB as a data URL). */
export const AVATAR_MAX_LENGTH = 80_000;
const AVATAR_DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;

export class UpdateMyProfileDto {
  @ApiPropertyOptional({
    description: 'Preferred language for the interface and emails',
    enum: ['ar', 'en'],
    example: 'ar',
  })
  @IsOptional()
  @IsIn(['ar', 'en'])
  preferredLanguage?: 'ar' | 'en';

  @ApiPropertyOptional({ example: 'Rand', maxLength: 128 })
  @IsOptional()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  firstName?: string;

  @ApiPropertyOptional({ example: 'Alhussaini', maxLength: 128 })
  @IsOptional()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  lastName?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  bio?: string;

  @ApiPropertyOptional({
    description:
      'College (free text, set during onboarding). Empty removes it.',
    maxLength: 160,
    example: 'كلية الهندسة وعلوم الحاسب',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(160)
  college?: string;

  @ApiPropertyOptional({
    description: 'Major (free text, set during onboarding). Empty removes it.',
    maxLength: 160,
    example: 'الذكاء الاصطناعي',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(160)
  major?: string;

  @ApiPropertyOptional({
    description:
      'Profile photo as a small data URL (PNG, JPEG or WebP, base64; the interface resizes it to 256 px). ' +
      `Up to ${AVATAR_MAX_LENGTH} characters. null removes the photo.`,
    nullable: true,
    type: String,
    example: 'data:image/jpeg;base64,/9j/4AAQSkZJRg...',
  })
  @IsOptional()
  @ValidateIf((o) => o.avatar !== null)
  @IsString()
  @MaxLength(AVATAR_MAX_LENGTH, {
    message: 'avatar is too large: choose a smaller image',
  })
  @Matches(AVATAR_DATA_URL, {
    message: 'avatar must be a PNG, JPEG or WebP image',
  })
  avatar?: string | null;

  @ApiPropertyOptional({
    description:
      'STUDENT only: student number (3-20 letters/digits/dashes, stored upper-case, unique within the university). ' +
      'null removes it — allowed only while a verified university e-mail exists (400 UNIVERSITY_IDENTITY_REQUIRED). ' +
      'The university e-mail is managed with POST /auth/university-email.',
    example: '2026001234',
    nullable: true,
    type: String,
  })
  @IsOptional()
  @ValidateIf((o) => o.studentNumber !== null)
  @NormalizeStudentNumber()
  @IsString()
  @Matches(STUDENT_NUMBER_PATTERN, {
    message: 'studentNumber must be 3-20 letters, digits or dashes',
  })
  studentNumber?: string | null;
}

export class OnboardingStateDto {
  @ApiProperty({ example: true })
  onboardingCompleted!: boolean;

  @ApiProperty({ type: Date })
  onboardingCompletedAt!: Date;
}

/** Exactly one of studentNumber / universityEmail (400 STUDENT_IDENTIFIER_REQUIRED). */
export class StudentIdentifierDto {
  @ApiPropertyOptional({
    example: '2026001234',
    description: 'Exact student number (case-insensitive)',
  })
  @IsOptional()
  @NormalizeStudentNumber()
  @IsString()
  @Matches(STUDENT_NUMBER_PATTERN, {
    message: 'studentNumber must be 3-20 letters, digits or dashes',
  })
  studentNumber?: string;

  @ApiPropertyOptional({
    example: 'n.alharbi@um.edu.sa',
    description: 'Exact VERIFIED university e-mail (case-insensitive)',
  })
  @IsOptional()
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  universityEmail?: string;
}

export class StudentSearchQueryDto extends StudentIdentifierDto {
  @ApiPropertyOptional({
    description:
      'One of your teams: availability is reported for this team (students can be in several teams). Without it, any of your teams.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  teamId?: string;
}

export class StudentUniversityDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
}

export class StudentSearchResultDto {
  @ApiProperty({
    example: 'Nada A.',
    description: 'First name + last-name initial',
  })
  displayName!: string;

  @ApiProperty({
    enum: ['STUDENT_NUMBER', 'UNIVERSITY_EMAIL'],
    description: 'Which identifier matched',
  })
  matchedBy!: 'STUDENT_NUMBER' | 'UNIVERSITY_EMAIL';

  @ApiProperty({
    example: '20******34',
    description:
      'Masked form of the matched identifier (e.g. "20******34", "n***@um.edu.sa")',
  })
  maskedIdentifier!: string;

  @ApiProperty({ type: StudentUniversityDto })
  university!: StudentUniversityDto;

  @ApiProperty({
    enum: ['AVAILABLE', 'IN_YOUR_TEAM', 'YOU'],
    description:
      'Whether the student can be invited to your team (being in other teams does not matter: students can work on several projects)',
  })
  availability!: 'AVAILABLE' | 'IN_YOUR_TEAM' | 'YOU';
}
