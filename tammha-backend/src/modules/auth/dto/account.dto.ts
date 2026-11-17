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
