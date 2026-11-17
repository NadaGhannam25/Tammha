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

export class SharedMeetingNoteDto {
  @ApiProperty() content!: string;
  @ApiProperty({ type: PublicUserDto, nullable: true })
  author!: PublicUserDto | null;
  @ApiProperty() updatedAt!: Date;
}

/** The caller's own notes (top-level fields) plus the supervisor's shared notes. */
export class MeetingNotesViewDto {
  @ApiProperty() meetingId!: string;
  @ApiProperty({ description: 'false until the caller writes their notes' })
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
  @ApiProperty({
    enum: ['SHARED_WITH_TEAM', 'PRIVATE'],
    description:
      "SHARED_WITH_TEAM: the supervisor's notes, read by the team. PRIVATE: a student's own notes",
  })
  visibility!: 'SHARED_WITH_TEAM' | 'PRIVATE';
  @ApiProperty({
    type: [SharedMeetingNoteDto],
    description: "The supervisor's notes (read-only) for the team's students",
  })
  shared!: SharedMeetingNoteDto[];
}
