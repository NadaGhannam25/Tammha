import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NormalizeEmail } from '@common/utils/normalize-email.transform';

export class LoginDto {
  @ApiProperty({
    description: 'User email address (case-insensitive)',
    example: 'student@university.edu',
  })
  @NormalizeEmail()
  @IsEmail()
  email!: string;

  @ApiProperty({ description: 'User password', example: 'SecurePassword123' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password!: string;

  @ApiPropertyOptional({
    enum: ['STUDENT', 'SUPERVISOR'],
    description:
      'Account type chosen on the sign-in page. When given and the account is of another type, the sign-in is refused with LOGIN_ROLE_MISMATCH (after the password check).',
  })
  @IsOptional()
  @IsIn(['STUDENT', 'SUPERVISOR'])
  role?: 'STUDENT' | 'SUPERVISOR';
}
