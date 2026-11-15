import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { PublicUserDto } from '@modules/teams/dto/team-response.dto';

export class UpsertMeetingNotesDto {
  @ApiProperty({
    maxLength: 20000,
    example:
      'Agreed: finish the survey by Thursday. Next meeting reviews chapter 2.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(20000)
  content!: string;
}

export class MeetingNotesViewDto {
  @ApiProperty() meetingId!: string;
  @ApiProperty({ description: 'false until someone writes the notes' })
  exists!: boolean;
  @ApiProperty({ description: 'Empty string when there are no notes yet' })
  content!: string;
  @ApiProperty({ type: PublicUserDto, nullable: true })
  createdBy!: PublicUserDto | null;
  @ApiProperty({
    type: PublicUserDto,
    nullable: true,
    description: 'Last editor',
  })
  updatedBy!: PublicUserDto | null;
  @ApiProperty({ nullable: true, type: Date }) createdAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) updatedAt!: Date | null;
  @ApiProperty() edited!: boolean;
}
