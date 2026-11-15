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
