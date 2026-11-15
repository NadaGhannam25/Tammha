import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
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
import { StrictRateLimit } from '@common/security/rate-limit.decorator';
import { TeamInvitationsService } from './team-invitations.service';
import { JoinTeamResultDto } from './dto/team-response.dto';
import {
  CreateTeamInvitationDto,
  TeamInvitationQueryDto,
  TeamInvitationViewDto,
} from './dto/team-invitation.dto';

/** P16: direct student invitations (by student number). */
@Controller()
@ApiTags('Teams')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles([UserRole.STUDENT])
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
export class TeamInvitationsController {
  constructor(private readonly invitations: TeamInvitationsService) {}

  @Post('teams/:id/student-invitations')
  @StrictRateLimit()
  @ApiOperation({
    summary:
      'Invite a classmate by student number or university e-mail (team leader)',
    description:
      'Exactly one of `studentNumber` or `universityEmail` (verified addresses only). The student gets a ' +
      'TEAM_INVITATION notification and accepts or declines. Same university only; the invitation code/link ' +
      'remains available too. The leader needs a university identity (403 UNIVERSITY_IDENTITY_REQUIRED).',
  })
  @ApiResponse({ status: 201, type: TeamInvitationViewDto })
  @ApiResponse({
    status: 400,
    description:
      'CANNOT_INVITE_YOURSELF, STUDENT_IDENTIFIER_REQUIRED (none or both) or validation error',
  })
  @ApiResponse({
    status: 403,
    description:
      'NOT_TEAM_LEADER, TEAM_ACCESS_DENIED or UNIVERSITY_IDENTITY_REQUIRED',
  })
  @ApiResponse({
    status: 404,
    description: 'STUDENT_NOT_FOUND or TEAM_NOT_FOUND',
  })
  @ApiResponse({
    status: 409,
    description:
      'INVITATION_ALREADY_PENDING, ALREADY_IN_THIS_TEAM or TEAM_FULL',
  })
  invite(
    @CurrentUser() user: AuthUser,
    @Param('id') teamId: string,
    @Body() dto: CreateTeamInvitationDto,
  ) {
    return this.invitations.invite(user, teamId, dto);
  }

  @Get('teams/:id/student-invitations')
  @ApiOperation({
    summary: 'Invitations sent by the team (students of the team)',
  })
  @ApiOkResponse({ type: [TeamInvitationViewDto] })
  @ApiResponse({ status: 403, description: 'TEAM_ACCESS_DENIED' })
  listForTeam(
    @CurrentUser() user: AuthUser,
    @Param('id') teamId: string,
    @Query() query: TeamInvitationQueryDto,
  ) {
    return this.invitations.listForTeam(user, teamId, query.status);
  }

  @Get('team-invitations/incoming')
  @ApiOperation({ summary: 'Team invitations I received' })
  @ApiOkResponse({ type: [TeamInvitationViewDto] })
  listMine(
    @CurrentUser() user: AuthUser,
    @Query() query: TeamInvitationQueryDto,
  ) {
    return this.invitations.listMine(user, query.status);
  }

  @Post('team-invitations/:invitationId/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept a team invitation (join the team as MEMBER)',
    description: 'Other pending invitations of the student are cancelled.',
  })
  @ApiOkResponse({ type: JoinTeamResultDto })
  @ApiResponse({ status: 404, description: 'INVITATION_NOT_FOUND' })
  @ApiResponse({
    status: 409,
    description:
      'INVITATION_NOT_PENDING, ALREADY_IN_THIS_TEAM, TEAM_FULL or UNIVERSITY_MISMATCH',
  })
  accept(@CurrentUser() user: AuthUser, @Param('invitationId') id: string) {
    return this.invitations.accept(user, id);
  }

  @Post('team-invitations/:invitationId/decline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Decline a team invitation' })
  @ApiOkResponse({ type: TeamInvitationViewDto })
  @ApiResponse({ status: 404, description: 'INVITATION_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'INVITATION_NOT_PENDING' })
  decline(@CurrentUser() user: AuthUser, @Param('invitationId') id: string) {
    return this.invitations.decline(user, id);
  }

  @Post('team-invitations/:invitationId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw a pending invitation (team leader)' })
  @ApiOkResponse({ type: TeamInvitationViewDto })
  @ApiResponse({ status: 403, description: 'NOT_TEAM_LEADER' })
  @ApiResponse({ status: 404, description: 'INVITATION_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'INVITATION_NOT_PENDING' })
  cancel(@CurrentUser() user: AuthUser, @Param('invitationId') id: string) {
    return this.invitations.cancel(user, id);
  }
}
