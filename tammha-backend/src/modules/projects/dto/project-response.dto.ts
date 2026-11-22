import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  SETUP_REQUIREMENT_CODES,
  SetupRequirementCode,
} from '../setup/project-setup-readiness.service';
import {
  MilestoneStatus,
  ProjectCategory,
  ProjectOrigin,
  ProjectRole,
  ProjectStatus,
  TeamRole,
} from '@prisma/client';
import { ProjectSetupStateDto } from './project-details.dto';
import {
  InvitationViewDto,
  PublicUserDto,
  TeamMemberViewDto,
} from '@modules/teams/dto/team-response.dto';

export class ProjectViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty({ enum: ProjectStatus }) status!: ProjectStatus;
  @ApiProperty({ nullable: true, type: Date }) startDate!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) endDate!: Date | null;
  @ApiProperty({ nullable: true, type: String }) thumbnail!: string | null;
  @ApiProperty() isPublic!: boolean;
  @ApiProperty() teamId!: string;
  // P16 details
  @ApiProperty({ nullable: true, type: String }) overview!: string | null;
  @ApiProperty({ type: [String] }) objectives!: string[];
  @ApiProperty({ enum: ProjectCategory, nullable: true })
  category!: ProjectCategory | null;
  @ApiProperty({ enum: ProjectOrigin, nullable: true })
  origin!: ProjectOrigin | null;
  @ApiProperty({ nullable: true, type: Date })
  expectedCompletionDate!: Date | null;
  @ApiProperty({ type: ProjectSetupStateDto }) setup!: ProjectSetupStateDto;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class WorkspaceTeamDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'University shared by all students of the team',
  })
  universityId!: string | null;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty({ nullable: true, type: String }) avatar!: string | null;
  @ApiProperty() memberCount!: number;
  @ApiProperty({ type: [TeamMemberViewDto] }) members!: TeamMemberViewDto[];
}

export class ProjectSupervisorDto {
  @ApiProperty() userId!: string;
  @ApiProperty({ enum: ProjectRole }) projectRole!: ProjectRole;
  @ApiProperty() linkedAt!: Date;
  @ApiProperty({ type: PublicUserDto }) user!: PublicUserDto;
}

export class WorkspaceViewerDto {
  @ApiProperty({ enum: ['STUDENT', 'SUPERVISOR'] }) role!: string;
  @ApiProperty({ enum: TeamRole, nullable: true })
  teamRole!: TeamRole | null;
  @ApiProperty({
    description:
      'Owner of this project (the team LEADER): only they hand the ownership over and delete the project',
  })
  isLeader!: boolean;
  @ApiProperty({
    description:
      'A student of this project team: every student manages the project alike',
  })
  canManage!: boolean;
  @ApiProperty({ description: 'Supervisor linked to this project' })
  isSupervisor!: boolean;
  @ApiProperty({
    description:
      'false for a STUDENT without a student number and without a verified university e-mail',
  })
  profileComplete!: boolean;
}

export class SetupReadinessDto {
  @ApiProperty({
    description:
      'POST /projects/:id/setup/complete would succeed (every requirement is met)',
  })
  canComplete!: boolean;
  @ApiProperty({
    enum: SETUP_REQUIREMENT_CODES,
    isArray: true,
    description:
      'What is still missing, in setup order. TEAM_LEADER_REQUIRED, EMAIL_NOT_VERIFIED (leader account e-mail), ' +
      'UNIVERSITY_IDENTITY_REQUIRED (leader student number / verified university e-mail), TEAM_NAME_REQUIRED, PROJECT_NAME_REQUIRED, ' +
      'PROJECT_DESCRIPTION_REQUIRED, PROJECT_OVERVIEW_REQUIRED, PROJECT_OBJECTIVES_REQUIRED, PROJECT_CATEGORY_REQUIRED, ' +
      'PROJECT_ORIGIN_REQUIRED, PROJECT_START_DATE_REQUIRED, PROJECT_END_DATE_REQUIRED (no longer raised: the expected completion date is optional) (expected completion or end date), ' +
      'PROJECT_DATES_INVALID (an end/expected completion date not after the start date), SUPERVISOR_REQUEST_REQUIRED ' +
      '(only with SETUP_REQUIRE_SUPERVISOR=true: no PENDING or ACCEPTED request), SUPERVISOR_APPROVAL_REQUIRED (only with SETUP_REQUIRE_SUPERVISOR_APPROVAL=true: ' +
      'the request is still pending), HANDBOOK_REQUIRED / HANDBOOK_PROCESSING / HANDBOOK_FAILED (no applicable handbook READY: ' +
      'select a library version or upload one).',
  })
  missingRequirements!: SetupRequirementCode[];
  @ApiProperty({ description: 'The setup is already completed' })
  completed!: boolean;
  @ApiProperty({ enum: ['NONE', 'PROCESSING', 'READY', 'FAILED'] })
  handbookState!: string;
  @ApiProperty({ enum: ['UPLOAD', 'LIBRARY'] })
  handbookSource!: 'UPLOAD' | 'LIBRARY';
  @ApiProperty({
    enum: ['PENDING', 'ACCEPTED'],
    nullable: true,
    type: String,
    description: 'Supervisor request that satisfies the supervisor step',
  })
  supervisorRequestStatus!: 'PENDING' | 'ACCEPTED' | null;
}

export class ProjectSetupDetailsDto {
  @ApiProperty({
    enum: [
      'TEAM',
      'SUPERVISOR',
      'DETAILS',
      'QUESTIONS',
      'HANDBOOK',
      'COMPLETED',
    ],
  })
  step!: string;
  @ApiProperty() completed!: boolean;
  @ApiProperty({ nullable: true, type: Date }) completedAt!: Date | null;
  @ApiProperty({ type: SetupReadinessDto }) readiness!: SetupReadinessDto;
}

export class WorkspaceProgressDto {
  @ApiProperty({ example: 45 }) percent!: number;
  @ApiProperty({ example: 60 }) readinessScore!: number;
  @ApiProperty({ example: 'IN_PROGRESS' }) readinessLevel!: string;
  @ApiProperty() totalTasks!: number;
  @ApiProperty() completedTasks!: number;
}

export class ProjectStageDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty({ nullable: true, type: Number, description: '1 = first stage' })
  order!: number | null;
  @ApiProperty() dueDate!: Date;
  @ApiProperty({ enum: MilestoneStatus }) status!: MilestoneStatus;
  @ApiProperty() totalTasks!: number;
  @ApiProperty() completedTasks!: number;
  @ApiProperty() percent!: number;
}

export class WorkspaceHandbookDto {
  @ApiProperty({
    enum: ['NONE', 'PROCESSING', 'READY', 'FAILED'],
    description:
      'State of the project handbook (see GET /projects/:id/handbook)',
  })
  state!: 'NONE' | 'PROCESSING' | 'READY' | 'FAILED';
  @ApiProperty({
    enum: ['UPLOAD', 'LIBRARY'],
    description:
      'LIBRARY: a handbook version selected from the library; UPLOAD: the PDF the leader uploaded',
  })
  source!: 'UPLOAD' | 'LIBRARY';
  @ApiProperty({ nullable: true, type: String }) title!: string | null;
  @ApiProperty({ nullable: true, type: Object })
  libraryVersion!: {
    id: string;
    handbookId: string;
    title: string;
    versionLabel: string;
    universityId: string;
    universityName: string;
    pageCount: number | null;
  } | null;
}

export class WorkspaceDto {
  @ApiProperty({ type: ProjectViewDto }) project!: ProjectViewDto;
  @ApiProperty({ type: WorkspaceTeamDto }) team!: WorkspaceTeamDto;
  @ApiProperty({
    type: PublicUserDto,
    nullable: true,
    description: 'The team leader (manages team, tasks and project details)',
  })
  leader!: PublicUserDto | null;
  @ApiProperty({ type: [ProjectSupervisorDto] })
  supervisors!: ProjectSupervisorDto[];
  @ApiPropertyOptional({
    type: InvitationViewDto,
    nullable: true,
    description: 'Invitation code/link — returned to the team leader only',
  })
  invitation!: InvitationViewDto | null;
  @ApiProperty({ type: WorkspaceViewerDto }) viewer!: WorkspaceViewerDto;
  @ApiProperty({ type: WorkspaceProgressDto }) progress!: WorkspaceProgressDto;
  @ApiProperty({
    type: [ProjectStageDto],
    description:
      'Project stages = milestones ordered by `order`, then due date',
  })
  stages!: ProjectStageDto[];
  @ApiProperty({ type: WorkspaceHandbookDto }) handbook!: WorkspaceHandbookDto;
  @ApiProperty({ type: SetupReadinessDto })
  setupReadiness!: SetupReadinessDto;
}

export class SupervisedProjectDto {
  @ApiProperty({ type: ProjectViewDto }) project!: ProjectViewDto;
  @ApiProperty() teamId!: string;
  @ApiProperty() teamName!: string;
  @ApiProperty() memberCount!: number;
  @ApiProperty({ enum: ProjectRole }) projectRole!: ProjectRole;
}
