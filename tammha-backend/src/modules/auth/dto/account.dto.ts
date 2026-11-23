import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { NormalizeEmail } from '@common/utils/normalize-email.transform';
import { IsStrongPassword } from '@common/utils/password-policy.validator';

/** Tokens are 43-character base64url strings (32 random bytes). */
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export class VerifyEmailDto {
  @ApiProperty({
    description: 'Token from the verification link (?token=...)',
    example: 'Q2hhbmdlTWUtdGhpcy1pcy1ub3QtYS1yZWFsLXRva2VuLTEy',
  })
  @IsString()
  @Matches(TOKEN_FORMAT, { message: 'token is invalid' })
  token!: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'student@university.edu' })
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'Token from the reset link (?token=...)' })
  @IsString()
  @Matches(TOKEN_FORMAT, { message: 'token is invalid' })
  token!: string;

  @ApiProperty({
    description:
      'New password: 8-128 characters, at most 72 bytes, at least one letter and one digit',
    example: 'NewSecurePassword123',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  @MaxLength(128)
  @IsStrongPassword()
  newPassword!: string;
}

export class UniversityEmailRequestDto {
  @ApiProperty({
    example: 'n.alharbi@um.edu.sa',
    description:
      "University e-mail (STUDENT). Must match the university's configured e-mail domains when it has any. Unique.",
  })
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  universityEmail!: string;
}

export class ConfirmAccountDeletionDto {
  @ApiProperty({
    example: '483920',
    description: 'The 6-digit code from the e-mail',
  })
  @IsString()
  @Matches(/^\s*\d{6}\s*$/, { message: 'code must be 6 digits' })
  code!: string;
}

/** P17: verify the account e-mail with the 6-digit code. */
export class VerifyEmailCodeDto {
  @ApiProperty({ example: 'student@university.edu' })
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({
    example: '483920',
    description: 'The 6-digit code from the e-mail',
  })
  @IsString()
  @Matches(/^\s*\d{6}\s*$/, { message: 'code must be 6 digits' })
  code!: string;
}

/** P17: send a new code. */
export class ResendVerificationCodeDto {
  @ApiProperty({ example: 'student@university.edu' })
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

/** P17: an unverified account moves to another address and gets a new code there. */
/** The signed-in, still unverified user uses another address (no password: the session proves it). */
export class ChangeOwnUnverifiedEmailDto {
  @ApiProperty({ example: 'student@gmail.com' })
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  newEmail!: string;
}

export class ChangeUnverifiedEmailDto {
  @ApiProperty({ example: 'student@pnu.edu.sa' })
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  currentEmail!: string;

  @ApiProperty({ description: 'The account password' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;

  @ApiProperty({ example: 'student@gmail.com' })
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  newEmail!: string;
}
