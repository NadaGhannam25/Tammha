import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';

/**
 * User response DTO - never includes password
 */
export class UniversityIdentityDto {
  @ApiProperty({ description: 'true for STUDENT accounts only' })
  required!: boolean;
  @ApiProperty({
    description:
      'true when not required, or when a student number or a VERIFIED university e-mail exists',
  })
  complete!: boolean;
  @ApiProperty({
    enum: ['STUDENT_NUMBER', 'UNIVERSITY_EMAIL'],
    isArray: true,
    description: 'Identifiers that currently satisfy the rule',
  })
  satisfiedBy!: ('STUDENT_NUMBER' | 'UNIVERSITY_EMAIL')[];
  @ApiProperty({ nullable: true, type: String }) studentNumber!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Verified university e-mail only',
  })
  universityEmail!: string | null;
  @ApiProperty() universityEmailVerified!: boolean;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Requested university e-mail waiting for its verification link',
  })
  pendingUniversityEmail!: string | null;
}

export class UserResponseDto {
  @ApiProperty({ example: 'clvt7xyz9k000abcdef1g' })
  id!: string;

  @ApiProperty({ example: 'student@university.edu' })
  email!: string;

  @ApiProperty({ example: 'Ahmed', required: false, nullable: true })
  firstName!: string | null;

  @ApiProperty({ example: 'Al-Rashid', required: false, nullable: true })
  lastName!: string | null;

  @ApiProperty({ enum: UserRole, example: UserRole.STUDENT })
  role!: UserRole;

  @ApiProperty({
    example: 'clvt7xyz9k000abcdef1g',
    required: false,
    nullable: true,
  })
  universityId!: string | null;

  @ApiProperty({ example: null, required: false, nullable: true })
  avatar!: string | null;

  @ApiProperty({ example: null, required: false, nullable: true })
  bio!: string | null;

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiProperty({
    example: '2026001234',
    nullable: true,
    description:
      'Student number (unique within the university); null for supervisors',
  })
  studentNumber!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    example: 'n.alharbi@um.edu.sa',
    description: 'Verified university e-mail (STUDENT); null until verified',
  })
  universityEmail!: string | null;

  @ApiProperty({ nullable: true, type: Date })
  universityEmailVerifiedAt!: Date | null;

  @ApiProperty({ nullable: true, type: String })
  pendingUniversityEmail!: string | null;

  @ApiProperty({ type: UniversityIdentityDto })
  universityIdentity!: UniversityIdentityDto;

  @ApiProperty({
    description:
      'false for a STUDENT without a student number and without a verified university e-mail. ' +
      'Such students cannot create a project, lead or manage a team, or complete project setup ' +
      '(403 UNIVERSITY_IDENTITY_REQUIRED).',
  })
  profileComplete!: boolean;

  @ApiProperty({
    example: false,
    description:
      'True once the account e-mail (sign-in, recovery, notifications) was verified',
  })
  emailVerified!: boolean;

  @ApiProperty({ nullable: true, type: Date })
  emailVerifiedAt!: Date | null;

  @ApiProperty({
    example: false,
    description:
      'True once the first-login onboarding was completed (on any device)',
  })
  onboardingCompleted!: boolean;

  @ApiProperty({ nullable: true, type: Date })
  onboardingCompletedAt!: Date | null;

  @ApiProperty({ example: '2026-09-28T12:00:00Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-09-28T12:00:00Z' })
  updatedAt!: Date;
}

/**
 * Authentication tokens response
 */
export class AuthTokensDto {
  @ApiProperty({
    description: 'JWT access token (valid for 1 hour)',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  accessToken!: string;

  @ApiProperty({
    description: 'Refresh token (valid for 30 days)',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  refreshToken!: string;

  @ApiProperty({
    description: 'Access token expiration in seconds (3600 for 1 hour)',
    example: 3600,
  })
  expiresIn!: number;
}

/**
 * Login response - user + tokens
 */
export class LoginResponseDto {
  @ApiProperty()
  user!: UserResponseDto;

  @ApiProperty()
  tokens!: AuthTokensDto;
  @ApiProperty({
    description:
      'true when the product requires a verified account e-mail: while user.emailVerified is false, ' +
      'show the verification screen (other routes answer 403 EMAIL_NOT_VERIFIED)',
  })
  emailVerificationRequired!: boolean;
}

/**
 * Register response - user + tokens
 */
export class RegisterResponseDto {
  @ApiProperty()
  user!: UserResponseDto;

  @ApiProperty()
  tokens!: AuthTokensDto;
  @ApiProperty({
    description:
      'true when the product requires a verified account e-mail: while user.emailVerified is false, ' +
      'show the verification screen (other routes answer 403 EMAIL_NOT_VERIFIED)',
  })
  emailVerificationRequired!: boolean;
}

/**
 * Me endpoint response - current user details
 */
export class MeResponseDto extends UserResponseDto {}

/**
 * Refresh endpoint response - new tokens only
 */
export class RefreshResponseDto extends AuthTokensDto {}

/** P16: account e-mail actions (verification, password reset) */
export class AccountMessageDto {
  @ApiProperty({
    example:
      'If an account exists for this e-mail, a reset link has been sent.',
  })
  message!: string;

  @ApiProperty({
    enum: ['ENABLED', 'NOT_CONFIGURED'],
    description:
      'Whether this server can send e-mails at all (server setting; says nothing about the account)',
  })
  emailDelivery!: 'ENABLED' | 'NOT_CONFIGURED';
}

export class VerifyEmailResponseDto {
  @ApiProperty({ example: 'Your e-mail address is verified.' })
  message!: string;

  @ApiProperty({ example: true })
  emailVerified!: boolean;
}

export class UniversityEmailRequestResultDto {
  @ApiProperty({
    enum: ['VERIFIED', 'PENDING_VERIFICATION'],
    description:
      'VERIFIED when the address is the already-verified account e-mail; otherwise a link was sent to it',
  })
  status!: 'VERIFIED' | 'PENDING_VERIFICATION';
  @ApiProperty() message!: string;
  @ApiProperty({ enum: ['ENABLED', 'NOT_CONFIGURED'] })
  emailDelivery!: 'ENABLED' | 'NOT_CONFIGURED';
  @ApiProperty({ type: UniversityIdentityDto })
  universityIdentity!: UniversityIdentityDto;
}

export class UniversityEmailVerifiedDto {
  @ApiProperty() message!: string;
  @ApiProperty({ example: true }) universityEmailVerified!: boolean;
  @ApiProperty({ type: UniversityIdentityDto })
  universityIdentity!: UniversityIdentityDto;
}
