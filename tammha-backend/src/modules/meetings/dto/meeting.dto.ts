import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import { AttendanceStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PageMetaDto, PaginationDto } from '@common/dtos/pagination.dto';
import { QueryBoolean } from '@common/utils/query-boolean.transform';
import { Trim } from '@common/utils/trim.transform';
import { PublicUserDto } from '@modules/teams/dto/team-response.dto';
import { MEETING_LIMITS } from '../meetings.config';

const L = MEETING_LIMITS;

export const MEETING_STATES = [
  'SCHEDULED',
  'ONGOING',
  'COMPLETED',
  'CANCELLED',
] as const;
export type MeetingState = (typeof MEETING_STATES)[number];

export class CreateMeetingDto {
  @ApiProperty() @IsString() @IsNotEmpty() projectId!: string;

  @ApiProperty({
    minLength: 3,
    maxLength: 150,
    example: 'Weekly supervisor meeting',
  })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(150)
  title!: string;

  @ApiPropertyOptional({ maxLength: 2000, nullable: true })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiProperty({
    example: '2026-11-02T09:00:00.000Z',
    description: 'ISO 8601 date-time with time zone; must be in the future',
  })
  @IsDateString({ strict: true, strictSeparator: true })
  scheduledAt!: string;

  @ApiPropertyOptional({
    minimum: L.MIN_DURATION,
    maximum: L.MAX_DURATION,
    default: L.DEFAULT_DURATION,
    description: 'Minutes',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(L.MIN_DURATION)
  @Max(L.MAX_DURATION)
  durationMinutes?: number;

  @ApiPropertyOptional({
    maxLength: 200,
    nullable: true,
    description:
      'Optional room/place note (the call itself is embedded in Tammha)',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(200)
  location?: string | null;

  @ApiPropertyOptional({
    type: [String],
    description:
      'User ids of the participants: students of the project team and/or its supervisor. ' +
      'Default on create: the whole team and the supervisor. The organiser is always included.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(L.MAX_PARTICIPANTS)
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  participantIds?: string[];
}

/** Every field optional; the project cannot be changed. participantIds replaces the list. */
export class UpdateMeetingDto extends PartialType(
  OmitType(CreateMeetingDto, ['projectId'] as const),
) {}

export class CancelMeetingDto {
  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Shown in the meeting details',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class MeetingListQueryDto extends PaginationDto {
  @ApiPropertyOptional() @IsOptional() @IsString() projectId?: string;

  @ApiPropertyOptional({ description: 'Start of the range (scheduledAt >=)' })
  @IsOptional()
  @IsDateString({ strict: true, strictSeparator: true })
  from?: string;

  @ApiPropertyOptional({ description: 'End of the range (scheduledAt <=)' })
  @IsOptional()
  @IsDateString({ strict: true, strictSeparator: true })
  to?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @QueryBoolean()
  includeCancelled?: boolean;

  @ApiPropertyOptional({
    description: 'Only meetings I participate in',
    default: false,
  })
  @IsOptional()
  @QueryBoolean()
  mine?: boolean;
}

export class UpcomingMeetingsQueryDto extends PaginationDto {
  @ApiPropertyOptional() @IsOptional() @IsString() projectId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 90, default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;

  @ApiPropertyOptional({
    description: 'Only meetings I participate in',
    default: false,
  })
  @IsOptional()
  @QueryBoolean()
  mine?: boolean;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export class MeetingParticipantDto {
  @ApiProperty({ type: PublicUserDto }) user!: PublicUserDto;
  @ApiProperty({ enum: AttendanceStatus }) attendance!: AttendanceStatus;
  @ApiProperty({
    nullable: true,
    type: Date,
    description: 'First time this participant joined',
  })
  joinedAt!: Date | null;
}

export class MeetingJoinWindowDto {
  @ApiProperty() opensAt!: Date;
  @ApiProperty() closesAt!: Date;
  @ApiProperty({
    description: 'A token can be requested now (window open, not cancelled)',
  })
  isOpen!: boolean;
}

export class MeetingViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() projectId!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty() scheduledAt!: Date;
  @ApiProperty() durationMinutes!: number;
  @ApiProperty() endsAt!: Date;
  @ApiProperty({ nullable: true, type: String }) location!: string | null;
  @ApiProperty({
    enum: MEETING_STATES,
    description:
      'CANCELLED, or derived from the time: SCHEDULED / ONGOING / COMPLETED',
  })
  status!: MeetingState;
  @ApiProperty({ nullable: true, type: Date }) cancelledAt!: Date | null;
  @ApiProperty({ nullable: true, type: String }) cancellationReason!:
    string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'LiveKit room identifier (joining still needs a token)',
  })
  roomName!: string | null;
  @ApiProperty({ type: PublicUserDto }) createdBy!: PublicUserDto;
  @ApiProperty({ type: [MeetingParticipantDto] })
  participants!: MeetingParticipantDto[];
  @ApiProperty({ description: 'The current user is a participant' })
  isParticipant!: boolean;
  @ApiProperty({ description: 'The current user may edit or cancel it' })
  canManage!: boolean;
  @ApiProperty({ type: MeetingJoinWindowDto }) join!: MeetingJoinWindowDto;
  @ApiProperty({ description: 'Notes were written (GET /meetings/:id/notes)' })
  hasNotes!: boolean;
  @ApiProperty({ nullable: true, type: Date }) notesUpdatedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class MeetingPageDto {
  @ApiProperty({ type: [MeetingViewDto] }) items!: MeetingViewDto[];
  @ApiProperty({ type: PageMetaDto }) meta!: PageMetaDto;
}

export class MeetingTokenDto {
  @ApiProperty({
    example: 'wss://your-project.livekit.cloud',
    description: 'Pass to the LiveKit client',
  })
  serverUrl!: string;
  @ApiProperty({
    description:
      'Short-lived JWT for this user and this room only. Never log or store it.',
  })
  token!: string;
  @ApiProperty() expiresAt!: Date;
  @ApiProperty() roomName!: string;
  @ApiProperty({ description: 'Participant identity = Tammha user id' })
  identity!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty() meetingId!: string;
}
