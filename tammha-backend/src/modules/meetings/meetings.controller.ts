import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '@modules/auth/guards/roles.guard';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { AuthUser } from '@common/types/auth-user.type';
import { MeetingsService } from './meetings.service';
import { MeetingNotesService } from './meeting-notes.service';
import {
  MeetingNotesViewDto,
  UpsertMeetingNotesDto,
} from './dto/meeting-notes.dto';
import {
  CancelMeetingDto,
  CreateMeetingDto,
  MeetingListQueryDto,
  MeetingPageDto,
  MeetingTokenDto,
  MeetingViewDto,
  UpcomingMeetingsQueryDto,
  UpdateMeetingDto,
} from './dto/meeting.dto';

@Controller('meetings')
@ApiTags('Meetings')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles([UserRole.STUDENT, UserRole.SUPERVISOR])
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
@ApiResponse({
  status: 403,
  description: 'Role not allowed (ADMIN) or PROJECT_ACCESS_DENIED',
})
export class MeetingsController {
  constructor(
    private readonly meetings: MeetingsService,
    private readonly notesService: MeetingNotesService,
  ) {}

  @Post()
  @ApiOperation({
    summary:
      'Schedule a meeting (students of the project team or its supervisor)',
    description:
      'Participants default to the whole team and the supervisor; the organiser is always included. ' +
      'A LiveKit room name is assigned. Participants are notified (in-app + email when enabled).',
  })
  @ApiCreatedResponse({ type: MeetingViewDto })
  @ApiResponse({
    status: 400,
    description:
      'Validation error, MEETING_IN_PAST or MEETING_PARTICIPANT_NOT_IN_PROJECT',
  })
  @ApiResponse({ status: 404, description: 'PROJECT_NOT_FOUND' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateMeetingDto) {
    return this.meetings.create(user, dto);
  }

  @Get()
  @ApiOperation({
    summary: 'List meetings of my project(s)',
    description:
      'Filters: projectId, from/to (scheduledAt), includeCancelled, mine (only meetings I participate in). Soonest first.',
  })
  @ApiOkResponse({ type: MeetingPageDto })
  findMany(@CurrentUser() user: AuthUser, @Query() query: MeetingListQueryDto) {
    return this.meetings.findMany(user, query);
  }

  @Get('upcoming')
  @ApiOperation({
    summary: 'Upcoming and ongoing meetings (not cancelled), soonest first',
    description:
      'Meetings starting within `days` (default 30) plus any that are running now.',
  })
  @ApiOkResponse({ type: MeetingPageDto })
  upcoming(
    @CurrentUser() user: AuthUser,
    @Query() query: UpcomingMeetingsQueryDto,
  ) {
    return this.meetings.findUpcoming(user, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Meeting details (members of the project)' })
  @ApiOkResponse({ type: MeetingViewDto })
  @ApiResponse({ status: 404, description: 'MEETING_NOT_FOUND' })
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.meetings.findOne(user, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a meeting (organiser or project supervisor)',
    description:
      'Any field; participantIds replaces the list. Changes to title, time, length, place or ' +
      'new participants notify the participants.',
  })
  @ApiOkResponse({ type: MeetingViewDto })
  @ApiResponse({
    status: 400,
    description:
      'Validation error, MEETING_IN_PAST or MEETING_PARTICIPANT_NOT_IN_PROJECT',
  })
  @ApiResponse({ status: 404, description: 'MEETING_NOT_FOUND' })
  @ApiResponse({
    status: 409,
    description: 'MEETING_CANCELLED or MEETING_ENDED',
  })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateMeetingDto,
  ) {
    return this.meetings.update(user, id, dto);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cancel a meeting (organiser or project supervisor)',
    description:
      'The meeting is kept (status CANCELLED, reason). Participants are notified.',
  })
  @ApiOkResponse({ type: MeetingViewDto })
  @ApiResponse({ status: 404, description: 'MEETING_NOT_FOUND' })
  @ApiResponse({
    status: 409,
    description: 'MEETING_CANCELLED or MEETING_ENDED',
  })
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: CancelMeetingDto,
  ) {
    return this.meetings.cancel(user, id, dto);
  }

  @Post(':id/token')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Get a LiveKit access token to join the meeting (participants only)',
    description:
      'Checks on EVERY request: current project membership (team student or project supervisor), ' +
      'listed participant, not cancelled, inside the join window ' +
      '(MEETING_JOIN_EARLY_MINUTES before start until MEETING_JOIN_GRACE_MINUTES after the end). ' +
      'Returns a short-lived token for this room only; the LiveKit API secret is never returned.',
  })
  @ApiOkResponse({ type: MeetingTokenDto })
  @ApiResponse({
    status: 403,
    description: 'PROJECT_ACCESS_DENIED or MEETING_NOT_PARTICIPANT',
  })
  @ApiResponse({ status: 404, description: 'MEETING_NOT_FOUND' })
  @ApiResponse({
    status: 409,
    description:
      'MEETING_CANCELLED, MEETING_NOT_OPEN_YET (with opensAt) or MEETING_ENDED',
  })
  @ApiResponse({
    status: 503,
    description:
      'INTEGRATION_DISABLED (LIVEKIT_ENABLED=false) or MEETING_TOKEN_UNAVAILABLE',
  })
  token(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.meetings.createJoinToken(user, id);
  }

  // ---------- notes ----------

  @Get(':id/notes')
  @ApiOperation({
    summary: 'Meeting notes',
    description:
      'Students of the project team and its supervisor. exists=false (empty content) until someone writes them.',
  })
  @ApiOkResponse({ type: MeetingNotesViewDto })
  @ApiResponse({ status: 404, description: 'MEETING_NOT_FOUND' })
  notes(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.notesService.get(user, id);
  }

  @Put(':id/notes')
  @ApiOperation({
    summary: 'Write or update the meeting notes',
    description:
      'Creates the notes the first time, then replaces their content. Project students and its supervisor. ' +
      'The author and the last editor are recorded.',
  })
  @ApiOkResponse({ type: MeetingNotesViewDto })
  @ApiResponse({
    status: 400,
    description: 'MEETING_NOTES_EMPTY or validation error',
  })
  @ApiResponse({ status: 404, description: 'MEETING_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'MEETING_CANCELLED' })
  writeNotes(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpsertMeetingNotesDto,
  ) {
    return this.notesService.upsert(user, id, dto);
  }
}
