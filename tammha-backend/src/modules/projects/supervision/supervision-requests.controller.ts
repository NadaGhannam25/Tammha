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
import { PublicUserDto } from '@modules/teams/dto/team-response.dto';
import { SupervisionRequestsService } from './supervision-requests.service';
import { CreateSupervisionRequestDto } from './dto/create-supervision-request.dto';
import { RespondSupervisionRequestDto } from './dto/respond-supervision-request.dto';
import { SupervisionRequestQueryDto } from './dto/supervision-request-query.dto';
import { SupervisionRequestViewDto } from './dto/supervision-response.dto';

@Controller()
@ApiTags('Supervision Requests')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
export class SupervisionRequestsController {
  constructor(private readonly service: SupervisionRequestsService) {}

  // ---------------- student ----------------

  @Get('supervision-requests/supervisors')
  @Roles([UserRole.STUDENT])
  @ApiOperation({ summary: "Active supervisors from the student's university" })
  @ApiOkResponse({ type: [PublicUserDto] })
  listSupervisors(@CurrentUser() user: AuthUser) {
    return this.service.listAvailableSupervisors(user);
  }

  @Post('projects/:id/supervision-requests')
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary: 'Send a supervision request to a SUPERVISOR (team leader)',
    description:
      'Only one PENDING request per project at a time and only one accepted supervisor per project. ' +
      'The supervisor must belong to the same university as the team.',
  })
  @ApiCreatedResponse({ type: SupervisionRequestViewDto })
  @ApiResponse({
    status: 400,
    description:
      'USER_NOT_SUPERVISOR, USER_INACTIVE, SUPERVISOR_NOT_VERIFIED or validation error',
  })
  @ApiResponse({
    status: 403,
    description: 'NOT_TEAM_LEADER or PROJECT_ACCESS_DENIED',
  })
  @ApiResponse({
    status: 404,
    description: 'USER_NOT_FOUND or PROJECT_NOT_FOUND',
  })
  @ApiResponse({
    status: 409,
    description:
      'SUPERVISOR_ALREADY_ASSIGNED, REQUEST_ALREADY_PENDING or UNIVERSITY_MISMATCH',
  })
  create(
    @CurrentUser() user: AuthUser,
    @Param('id') projectId: string,
    @Body() dto: CreateSupervisionRequestDto,
  ) {
    return this.service.createRequest(
      user,
      projectId,
      dto.supervisorEmail,
      dto.message,
    );
  }

  @Get('projects/:id/supervision-requests')
  @Roles([UserRole.STUDENT, UserRole.SUPERVISOR])
  @ApiOperation({
    summary: "Project's supervision requests (team students or its supervisor)",
  })
  @ApiOkResponse({ type: [SupervisionRequestViewDto] })
  @ApiResponse({ status: 403, description: 'PROJECT_ACCESS_DENIED' })
  listForProject(
    @CurrentUser() user: AuthUser,
    @Param('id') projectId: string,
    @Query() query: SupervisionRequestQueryDto,
  ) {
    return this.service.listProjectRequests(user, projectId, query.status);
  }

  @Post('supervision-requests/:requestId/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles([UserRole.STUDENT])
  @ApiOperation({ summary: 'Cancel a PENDING request (team leader)' })
  @ApiOkResponse({ type: SupervisionRequestViewDto })
  @ApiResponse({
    status: 403,
    description: 'NOT_TEAM_LEADER or REQUEST_ACCESS_DENIED',
  })
  @ApiResponse({ status: 404, description: 'REQUEST_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'REQUEST_NOT_PENDING' })
  cancel(@CurrentUser() user: AuthUser, @Param('requestId') requestId: string) {
    return this.service.cancelRequest(user, requestId);
  }

  // ---------------- supervisor ----------------

  @Get('supervision-requests/incoming')
  @Roles([UserRole.SUPERVISOR])
  @ApiOperation({ summary: 'Requests sent to the current supervisor' })
  @ApiOkResponse({ type: [SupervisionRequestViewDto] })
  listIncoming(
    @CurrentUser() user: AuthUser,
    @Query() query: SupervisionRequestQueryDto,
  ) {
    return this.service.listIncoming(user, query.status);
  }

  @Post('supervision-requests/:requestId/accept')
  @HttpCode(HttpStatus.OK)
  @Roles([UserRole.SUPERVISOR])
  @ApiOperation({
    summary: 'Accept a request — links the supervisor to the project',
    description:
      'Runs in one transaction: link via project_members (PROJECT_MANAGER), mark ACCEPTED, ' +
      'cancel any other pending request for the project.',
  })
  @ApiOkResponse({ type: SupervisionRequestViewDto })
  @ApiResponse({
    status: 403,
    description: 'REQUEST_ACCESS_DENIED — not sent to you',
  })
  @ApiResponse({ status: 404, description: 'REQUEST_NOT_FOUND' })
  @ApiResponse({
    status: 409,
    description:
      'REQUEST_NOT_PENDING, SUPERVISOR_ALREADY_ASSIGNED or UNIVERSITY_MISMATCH',
  })
  accept(
    @CurrentUser() user: AuthUser,
    @Param('requestId') requestId: string,
    @Body() dto: RespondSupervisionRequestDto,
  ) {
    return this.service.acceptRequest(user, requestId, dto.note);
  }

  @Post('supervision-requests/:requestId/reject')
  @HttpCode(HttpStatus.OK)
  @Roles([UserRole.SUPERVISOR])
  @ApiOperation({ summary: 'Reject a request' })
  @ApiOkResponse({ type: SupervisionRequestViewDto })
  @ApiResponse({ status: 403, description: 'REQUEST_ACCESS_DENIED' })
  @ApiResponse({ status: 404, description: 'REQUEST_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'REQUEST_NOT_PENDING' })
  reject(
    @CurrentUser() user: AuthUser,
    @Param('requestId') requestId: string,
    @Body() dto: RespondSupervisionRequestDto,
  ) {
    return this.service.rejectRequest(user, requestId, dto.note);
  }
}
