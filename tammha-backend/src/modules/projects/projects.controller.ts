import {
  Body,
  Controller,
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
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { UpdateSetupStepDto } from './dto/project-details.dto';
import {
  SupervisedProjectDto,
  WorkspaceDto,
  ProjectSetupDetailsDto,
} from './dto/project-response.dto';

@Controller('projects')
@ApiTags('Projects')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Post()
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary: 'Create a graduation project workspace (STUDENT only)',
    description:
      'Creates the project, its team and an invitation code in one transaction. ' +
      'The creator becomes the team LEADER. The project starts in setup ' +
      '(project.setup.step = TEAM) — move through the wizard with PATCH /projects/:id/setup ' +
      'and finish with POST /projects/:id/setup/complete. A student can create several ' +
      'projects; each has its own team, tasks, documents, meetings and permissions.',
  })
  @ApiCreatedResponse({ type: WorkspaceDto })
  @ApiResponse({
    status: 400,
    description: 'Validation error or INVALID_DATE_RANGE',
  })
  @ApiResponse({
    status: 403,
    description: 'Only STUDENT accounts can create projects',
  })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProjectDto) {
    return this.projectsService.createWorkspace(user, dto);
  }

  @Get()
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary: "List all of the current student's projects",
    description:
      'One workspace per project the student belongs to (as leader or member), most recently joined first. Empty list = no project yet.',
  })
  @ApiOkResponse({ type: [WorkspaceDto] })
  listMine(@CurrentUser() user: AuthUser) {
    return this.projectsService.listMyWorkspaces(user);
  }

  @Get('me')
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary: "Get the current student's most recently joined project workspace",
    description:
      'Students can have several projects: use GET /projects for all of them and GET /projects/:id for one.',
  })
  @ApiOkResponse({ type: WorkspaceDto })
  @ApiResponse({ status: 404, description: 'NOT_IN_TEAM — no workspace yet' })
  getMine(@CurrentUser() user: AuthUser) {
    return this.projectsService.getMyWorkspace(user);
  }

  @Get('supervised')
  @Roles([UserRole.SUPERVISOR])
  @ApiOperation({ summary: 'List projects assigned to the current supervisor' })
  @ApiOkResponse({ type: [SupervisedProjectDto] })
  getSupervised(@CurrentUser() user: AuthUser) {
    return this.projectsService.listSupervisedProjects(user);
  }

  @Get(':id')
  @Roles([UserRole.STUDENT, UserRole.SUPERVISOR])
  @ApiOperation({
    summary: 'View a project workspace',
    description:
      'Students of the project team, or supervisors assigned to the project.',
  })
  @ApiOkResponse({ type: WorkspaceDto })
  @ApiResponse({ status: 403, description: 'PROJECT_ACCESS_DENIED' })
  @ApiResponse({ status: 404, description: 'PROJECT_NOT_FOUND' })
  getOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.projectsService.getWorkspace(user, id);
  }

  @Patch(':id')
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary: 'Update project details (team leader)',
    description:
      'Editable: name, description, startDate, endDate, overview, objectives, category, origin, expectedCompletionDate. Unknown fields are rejected.',
  })
  @ApiOkResponse({ type: WorkspaceDto })
  @ApiResponse({
    status: 400,
    description: 'Validation error or INVALID_DATE_RANGE',
  })
  @ApiResponse({
    status: 403,
    description: 'NOT_TEAM_LEADER or PROJECT_ACCESS_DENIED',
  })
  @ApiResponse({ status: 404, description: 'PROJECT_NOT_FOUND' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projectsService.updateProject(user, id, dto);
  }

  // ---------- P16: setup wizard ----------

  @Patch(':id/setup')
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary: 'Save the current setup step (team leader)',
    description:
      'Steps: TEAM → SUPERVISOR → DETAILS → QUESTIONS → HANDBOOK. The leader can leave and resume later; GET /projects/me returns project.setup.',
  })
  @ApiOkResponse({ type: WorkspaceDto })
  @ApiResponse({
    status: 403,
    description: 'NOT_TEAM_LEADER or PROJECT_ACCESS_DENIED',
  })
  @ApiResponse({ status: 409, description: 'SETUP_ALREADY_COMPLETED' })
  setSetupStep(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateSetupStepDto,
  ) {
    return this.projectsService.setSetupStep(user, id, dto.step);
  }

  @Get(':id/setup')
  @Roles([UserRole.STUDENT, UserRole.SUPERVISOR])
  @ApiOperation({
    summary:
      'Setup step and readiness (what is still missing to complete the setup)',
    description:
      'Same readiness check as POST /projects/:id/setup/complete (also returned as `setupReadiness` in the workspace).',
  })
  @ApiOkResponse({ type: ProjectSetupDetailsDto })
  getSetup(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.projectsService.getSetupState(user, id);
  }

  @Post(':id/setup/complete')
  @HttpCode(HttpStatus.OK)
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary:
      'Complete the project setup (team leader; all requirements checked)',
    description:
      'The only way to complete setup. Requires: verified leader account e-mail, leader university identity, ' +
      'project name, description, overview, objectives, category, origin, start date and expected completion/end date ' +
      'after it, a PENDING or ACCEPTED supervisor request, and a READY project handbook. Invited students do not have ' +
      'to accept and the supervisor does not have to answer. Idempotent once completed; creates no tasks.',
  })
  @ApiOkResponse({ type: WorkspaceDto })
  @ApiResponse({
    status: 403,
    description:
      'NOT_TEAM_LEADER, PROJECT_ACCESS_DENIED or EMAIL_NOT_VERIFIED (when verification is required)',
  })
  @ApiResponse({
    status: 422,
    description:
      'PROJECT_SETUP_INCOMPLETE — details.missingRequirements lists the missing requirement codes (see SetupReadinessDto)',
  })
  completeSetup(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.projectsService.completeSetup(user, id);
  }
}
