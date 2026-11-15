import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
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
}
