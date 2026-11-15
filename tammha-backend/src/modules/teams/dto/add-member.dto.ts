import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';
import { NormalizeEmail } from '@common/utils/normalize-email.transform';

export class AddTeamMemberDto {
  @ApiProperty({
    example: 'classmate@university.edu',
    description:
      'Email of a registered, active STUDENT who is not in any team yet',
  })
  @NormalizeEmail()
  @IsEmail()
  email!: string;
}
