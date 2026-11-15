import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';
import { NormalizeEmail } from '@common/utils/normalize-email.transform';
import { Trim } from '@common/utils/trim.transform';

export class CreateSupervisionRequestDto {
  @ApiProperty({
    example: 'dr.supervisor@university.edu',
    description:
      'Email of an active SUPERVISOR from the same university as the team',
  })
  @NormalizeEmail()
  @IsEmail()
  supervisorEmail!: string;

  @ApiPropertyOptional({
    example:
      'We would be honored if you could supervise our graduation project.',
    maxLength: 1000,
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  message?: string;
}
