import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Trim } from '@common/utils/trim.transform';

export class JoinTeamDto {
  @ApiProperty({
    example: 'K7QXM2PA',
    description:
      'Invitation code (case-insensitive, dashes allowed) OR the full invitation link, e.g. https://app.example/join/K7QXM2PA',
  })
  @Trim()
  @IsString()
  @IsNotEmpty({ message: 'Invitation code or link is required' })
  @MaxLength(500)
  code!: string;
}
