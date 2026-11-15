import { StrictRateLimit } from '@common/security/rate-limit.decorator';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '@modules/auth/guards/roles.guard';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { AuthUser } from '@common/types/auth-user.type';
import { TeamsService } from './teams.service';
import { UpdateTeamDto } from './dto/update-team.dto';
import { AddTeamMemberDto } from './dto/add-member.dto';
import { SetTeamLeaderDto } from './dto/set-leader.dto';
import { JoinTeamDto } from './dto/join-team.dto';
import {
  InvitationPreviewDto,
  InvitationViewDto,
  JoinTeamResultDto,
  TeamMemberViewDto,
  TeamViewDto,
} from './dto/team-response.dto';

const ERROR_SHAPE = {
  example: {
    statusCode: 409,
    timestamp: '2026-10-05T12:00:00.000Z',
    path: '/api/v1/teams/join',
    code: 'ALREADY_IN_THIS_TEAM',
    message: 'You are already a member of this team',
  },
};

@Controller('teams')
@ApiTags('Teams')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
export class TeamsController {
  constructor(private readonly teamsService: TeamsService) {}

  // ---------- current student ----------

  @Get()
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary: "List all of the current student's teams (one per project)",
  })
  @ApiOkResponse({ type: [TeamViewDto] })
  listMine(@CurrentUser() user: AuthUser) {
    return this.teamsService.listMyTeams(user);
  }

  @Get('me')
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary: "Get the current student's most recently joined team",
    description:
      'Students can be in several teams: GET /teams lists all of them.',
  })
  @ApiOkResponse({ type: TeamViewDto })
  @ApiResponse({
    status: 404,
    description: 'NOT_IN_TEAM — student has no team yet',
  })
  getMyTeam(@CurrentUser() user: AuthUser) {
    return this.teamsService.getMyTeam(user);
  }

  // ---------- invitations (declared before :id routes) ----------

  @Post('join')
  @StrictRateLimit()
  @HttpCode(HttpStatus.OK)
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary: 'Join a team using an invitation code or link (STUDENT only)',
    description:
      'Accepts the 8-character code (case-insensitive, dashes allowed) or the full invitation link. ' +
      'A student can belong to several teams (one per project), never twice to the same team.',
  })
  @ApiOkResponse({ type: JoinTeamResultDto })
  @ApiResponse({
    status: 400,
    description: 'INVITATION_MALFORMED or validation error',
    schema: ERROR_SHAPE,
  })
  @ApiResponse({
    status: 403,
    description: 'Only STUDENT accounts can join teams',
  })
  @ApiResponse({
    status: 404,
    description: 'INVITATION_INVALID — unknown or replaced code',
  })
  @ApiResponse({
    status: 409,
    description: 'ALREADY_IN_THIS_TEAM or TEAM_FULL',
    schema: ERROR_SHAPE,
  })
  join(@CurrentUser() user: AuthUser, @Body() dto: JoinTeamDto) {
    return this.teamsService.joinByInvitation(user, dto.code);
  }

  @Get('invitations/:code')
  @StrictRateLimit()
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary:
      'Preview the team/project behind an invitation code before joining',
  })
  @ApiParam({ name: 'code', example: 'K7QXM2PA' })
  @ApiOkResponse({ type: InvitationPreviewDto })
  @ApiResponse({ status: 400, description: 'INVITATION_MALFORMED' })
  @ApiResponse({ status: 404, description: 'INVITATION_INVALID' })
  previewInvitation(@Param('code') code: string) {
    return this.teamsService.previewInvitation(code);
  }

  // ---------- team by id ----------

  @Patch(':id')
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary: 'Update team name/description (team leader)',
  })
  @ApiOkResponse({ type: TeamViewDto })
  @ApiResponse({
    status: 403,
    description: 'NOT_TEAM_LEADER (team leader only) or TEAM_ACCESS_DENIED',
  })
  @ApiResponse({ status: 404, description: 'TEAM_NOT_FOUND' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateTeamDto,
  ) {
    return this.teamsService.updateTeam(user, id, dto);
  }

  @Get(':id/members')
  @Roles([UserRole.STUDENT, UserRole.SUPERVISOR])
  @ApiOperation({
    summary: 'List team members',
    description:
      'Students of the team, or a supervisor linked to the team project.',
  })
  @ApiOkResponse({ type: [TeamMemberViewDto] })
  @ApiResponse({ status: 403, description: 'TEAM_ACCESS_DENIED' })
  @ApiResponse({ status: 404, description: 'TEAM_NOT_FOUND' })
  getMembers(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.teamsService.getMembers(user, id);
  }

  @Post(':id/members')
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary: 'Add a registered student to the team by email (team leader)',
    description:
      'Adds immediately. To let the student accept first, use POST /teams/:id/student-invitations (by student number).',
  })
  @ApiResponse({ status: 201, type: [TeamMemberViewDto] })
  @ApiResponse({
    status: 400,
    description: 'USER_NOT_STUDENT, USER_INACTIVE or validation error',
  })
  @ApiResponse({
    status: 403,
    description: 'NOT_TEAM_LEADER (team leader only) or TEAM_ACCESS_DENIED',
  })
  @ApiResponse({ status: 404, description: 'USER_NOT_FOUND or TEAM_NOT_FOUND' })
  @ApiResponse({
    status: 409,
    description: 'ALREADY_IN_THIS_TEAM or TEAM_FULL',
  })
  addMember(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AddTeamMemberDto,
  ) {
    return this.teamsService.addMember(user, id, dto.email);
  }

  @Delete(':id/members/:userId')
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary:
      'Remove a member (team leader) or leave the team (pass your own user id)',
    description:
      'The last member cannot be removed. When the leader leaves, the earliest remaining member becomes the leader.',
  })
  @ApiResponse({ status: 200, description: 'Member removed / left team' })
  @ApiResponse({
    status: 403,
    description: 'NOT_TEAM_LEADER (team leader only) or TEAM_ACCESS_DENIED',
  })
  @ApiResponse({
    status: 404,
    description: 'MEMBER_NOT_FOUND or TEAM_NOT_FOUND',
  })
  @ApiResponse({ status: 409, description: 'LAST_MEMBER' })
  removeMember(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    return this.teamsService.removeMember(user, id, userId);
  }

  @Patch(':id/leader')
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary: 'Transfer team leadership to another member (team leader)',
    description:
      'The LEADER manages the team, invitations, the supervisor request, project details, tasks, milestones and the handbook. Leadership moves with all its permissions.',
  })
  @ApiOkResponse({ type: [TeamMemberViewDto] })
  @ApiResponse({
    status: 403,
    description: 'NOT_TEAM_LEADER (team leader only) or TEAM_ACCESS_DENIED',
  })
  @ApiResponse({ status: 404, description: 'MEMBER_NOT_FOUND' })
  setLeader(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: SetTeamLeaderDto,
  ) {
    return this.teamsService.setLeader(user, id, dto.userId);
  }

  @Get(':id/invitation')
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary: 'Get the team invitation code and shareable link (team leader)',
  })
  @ApiOkResponse({ type: InvitationViewDto })
  @ApiResponse({
    status: 403,
    description: 'NOT_TEAM_LEADER (team leader only) or TEAM_ACCESS_DENIED',
  })
  getInvitation(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.teamsService.getInvitation(user, id);
  }

  @Post(':id/invitation/regenerate')
  @HttpCode(HttpStatus.OK)
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary: 'Generate a new invitation code (team leader)',
    description: 'The previous code and link stop working immediately.',
  })
  @ApiOkResponse({ type: InvitationViewDto })
  @ApiResponse({
    status: 403,
    description: 'NOT_TEAM_LEADER (team leader only) or TEAM_ACCESS_DENIED',
  })
  regenerateInvitation(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.teamsService.regenerateInvitation(user, id);
  }
}
