import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class SetTeamLeaderDto {
  @ApiProperty({
    example: 'clvt7xyz9k000abcdef1g',
    description:
      'User ID of a current team member. LEADER is a display label only.',
  })
  @IsString()
  @IsNotEmpty()
  userId!: string;
}
