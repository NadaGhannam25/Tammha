import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ProjectSetupReadinessService } from './setup/project-setup-readiness.service';
import { loadEffectiveHandbook } from '@modules/ai-support/handbook/handbook-state';
import {
  assertUniversityIdentity,
  hasUniversityIdentity,
} from '@common/identity/university-identity';
import {
  Prisma,
  Project,
  ProjectCategory,
  ProjectOrigin,
  ProjectSetupStep,
  TaskStatus,
  TeamRole,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuthUser } from '@common/types/auth-user.type';
import { WorkspaceAccessService } from '@common/workspace/workspace-access.service';
import {
  WorkspaceErrorCode as E,
  workspaceError,
} from '@common/workspace/workspace-errors';
import { PUBLIC_USER_SELECT } from '@common/workspace/user-select';
import { TeamsService } from '@modules/teams/teams.service';
import { ProjectMetricsService } from '@modules/dashboard/progress/project-metrics.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { ProjectDetailsDto } from './dto/project-details.dto';
import {
  ProjectStageDto,
  ProjectSupervisorDto,
  ProjectViewDto,
  SupervisedProjectDto,
  WorkspaceDto,
  WorkspaceHandbookDto,
  ProjectSetupDetailsDto,
} from './dto/project-response.dto';

type Db = PrismaService | Prisma.TransactionClient;

/** Milestones = project stages: explicit order first, then due date (stable). */
export const STAGE_ORDER_BY: Prisma.MilestoneOrderByWithRelationInput[] = [
  { sortOrder: { sort: 'asc', nulls: 'last' } },
  { dueDate: 'asc' },
  { id: 'asc' },
];

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly teamsService: TeamsService,
    private readonly metrics: ProjectMetricsService,
    private readonly readiness: ProjectSetupReadinessService,
  ) {}

  /**
   * Creates the graduation project workspace in ONE transaction:
   * team (with invitation code) + creator as team LEADER + project.
   * P16: the project starts in setup (step TEAM) until the leader completes it.
   */
  async createWorkspace(
    user: AuthUser,
    dto: CreateProjectDto,
  ): Promise<WorkspaceDto> {
    if (!user.universityId) {
      throw new BadRequestException(
        workspaceError(
          E.UNIVERSITY_REQUIRED,
          'Your account has no university. A university is required to create a project team.',
        ),
      );
    }
    // the creator becomes the team LEADER: a university identity is required
    assertUniversityIdentity(user);
    this.assertDateRange(this.toDate(dto.startDate), this.toDate(dto.endDate));

    // A student can create several projects; each gets its own team with the creator
    // as LEADER, so teams, tasks, documents, meetings and permissions stay separate.
    const projectId = await this.prisma.$transaction(async (tx) => {
      const team = await tx.team.create({
        data: {
          name: dto.teamName ?? `${dto.name} Team`.slice(0, 100),
          description: dto.teamDescription || null,
          inviteCode: await this.teamsService.generateUniqueInviteCode(tx),
          inviteCodeUpdatedAt: new Date(),
        },
      });

      await tx.teamMember.create({
        data: { teamId: team.id, userId: user.id, role: TeamRole.LEADER },
      });

      const project = await tx.project.create({
        data: {
          name: dto.name,
          description: dto.description || null,
          teamId: team.id,
          startDate: this.toDate(dto.startDate),
          endDate: this.toDate(dto.endDate),
          ...this.detailsData(dto),
          setupStep: ProjectSetupStep.TEAM,
          setupCompletedAt: null,
        },
      });

      return project.id;
    });

    return this.buildWorkspace(projectId, user);
  }

  /** All projects of the current student (most recently joined first). */
  async listMyWorkspaces(user: AuthUser): Promise<WorkspaceDto[]> {
    const memberships = await this.access.findStudentMemberships(user.id);
    const projects = await this.prisma.project.findMany({
      where: { teamId: { in: memberships.map((m) => m.teamId) } },
      select: { id: true, teamId: true },
    });
    const order = new Map(memberships.map((m, i) => [m.teamId, i]));
    projects.sort((a, b) => order.get(a.teamId)! - order.get(b.teamId)!);
    const result: WorkspaceDto[] = [];
    for (const p of projects)
      result.push(await this.buildWorkspace(p.id, user));
    return result;
  }

  /**
   * The current student's most recently joined project workspace (students can have
   * several projects: GET /projects lists them all; GET /projects/:id opens one).
   */
  async getMyWorkspace(user: AuthUser): Promise<WorkspaceDto> {
    const [membership] = await this.access.findStudentMemberships(user.id);
    const project = membership
      ? await this.prisma.project.findUnique({
          where: { teamId: membership.teamId },
        })
      : null;

    if (!project) {
      throw new NotFoundException(
        workspaceError(
          E.NOT_IN_TEAM,
          'You do not have a project workspace yet. Create one or join a team with an invitation code.',
        ),
      );
    }
    return this.buildWorkspace(project.id, user);
  }

  async getWorkspace(user: AuthUser, projectId: string): Promise<WorkspaceDto> {
    await this.access.assertCanViewProject(user, projectId);
    return this.buildWorkspace(projectId, user);
  }

  /** Team LEADER only (P16). */
  async updateProject(
    user: AuthUser,
    projectId: string,
    dto: UpdateProjectDto,
  ): Promise<WorkspaceDto> {
    const current = await this.access.assertLeaderOfProject(user, projectId);

    const data: Prisma.ProjectUpdateInput = { ...this.detailsData(dto) };
    if (typeof dto.name === 'string') data.name = dto.name;
    if (dto.description !== undefined)
      data.description = dto.description || null;
    if (dto.startDate !== undefined)
      data.startDate = this.toDate(dto.startDate);
    if (dto.endDate !== undefined) data.endDate = this.toDate(dto.endDate);

    const nextStart =
      dto.startDate !== undefined
        ? this.toDate(dto.startDate)
        : current.startDate;
    const nextEnd =
      dto.endDate !== undefined ? this.toDate(dto.endDate) : current.endDate;
    this.assertDateRange(nextStart, nextEnd);

    await this.prisma.project.update({ where: { id: projectId }, data });
    return this.buildWorkspace(projectId, user);
  }

  // ==========================================================
  // P16: first-project setup wizard
  // ==========================================================

  /** Records the wizard screen the leader is on, so setup can be resumed later. */
  async setSetupStep(
    user: AuthUser,
    projectId: string,
    step: ProjectSetupStep,
  ): Promise<WorkspaceDto> {
    const project = await this.access.assertLeaderOfProject(user, projectId);
    if (project.setupStep === ProjectSetupStep.COMPLETED) {
      throw new ConflictException(
        workspaceError(
          E.SETUP_ALREADY_COMPLETED,
          'The project setup is already completed',
        ),
      );
    }
    await this.prisma.project.update({
      where: { id: projectId },
      data: { setupStep: step },
    });
    return this.buildWorkspace(projectId, user);
  }

  /** Setup step + the central readiness check (students of the project, its supervisor). */
  async getSetupState(
    user: AuthUser,
    projectId: string,
  ): Promise<ProjectSetupDetailsDto> {
    const project = await this.access.assertCanViewProject(user, projectId);
    const readiness = await this.readiness.evaluate(project.id);
    return {
      step: project.setupStep,
      completed: project.setupStep === ProjectSetupStep.COMPLETED,
      completedAt: project.setupCompletedAt,
      readiness,
    };
  }

  /**
   * Complete Project Setup — the ONLY way a project becomes set up (setupStep and
   * setupCompletedAt are never accepted from the client).
   *
   * Only the team LEADER; every readiness requirement is re-checked inside the
   * transaction that marks the project complete (row lock on the project). Missing
   * requirements => 422 PROJECT_SETUP_INCOMPLETE with details.missingRequirements.
   * Idempotent once completed. No tasks are created: a project without tasks stays an
   * empty project, ready for the AI-assisted Tasks flow.
   */
  async completeSetup(
    user: AuthUser,
    projectId: string,
  ): Promise<WorkspaceDto> {
    const project = await this.access.assertLeaderMembershipOfProject(
      user,
      projectId,
    );
    if (project.setupStep !== ProjectSetupStep.COMPLETED) {
      await this.prisma.$transaction(async (tx) => {
        // serialise concurrent completions / edits of the same project
        await tx.project.update({
          where: { id: project.id },
          data: { updatedAt: new Date() },
        });
        const readiness = await this.readiness.evaluate(project.id, tx);
        if (readiness.completed) return;
        if (!readiness.canComplete) {
          throw new UnprocessableEntityException({
            code: 'PROJECT_SETUP_INCOMPLETE',
            message:
              'The project setup cannot be completed yet: some required steps are missing.',
            details: { missingRequirements: readiness.missingRequirements },
          });
        }
        await tx.project.updateMany({
          where: {
            id: project.id,
            setupStep: { not: ProjectSetupStep.COMPLETED },
          },
          data: {
            setupStep: ProjectSetupStep.COMPLETED,
            setupCompletedAt: new Date(),
          },
        });
      });
    }
    return this.buildWorkspace(projectId, user);
  }

  /** Projects the current SUPERVISOR is linked to through project_members. */
  async listSupervisedProjects(
    user: AuthUser,
  ): Promise<SupervisedProjectDto[]> {
    const links = await this.prisma.projectMember.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    if (links.length === 0) return [];

    const projects = await this.prisma.project.findMany({
      where: { id: { in: links.map((l) => l.projectId) } },
    });
    const byId = new Map(projects.map((p) => [p.id, p]));

    const result: SupervisedProjectDto[] = [];
    for (const link of links) {
      const project = byId.get(link.projectId);
      if (!project) continue;
      const team = await this.prisma.team.findUnique({
        where: { id: project.teamId },
      });
      const memberCount = await this.prisma.teamMember.count({
        where: { teamId: project.teamId },
      });
      result.push({
        project: this.toProjectView(project),
        teamId: project.teamId,
        teamName: team?.name ?? '',
        memberCount,
        projectRole: link.role,
      });
    }
    return result;
  }

  // ==========================================================
  // Internals
  // ==========================================================

  private detailsData(dto: ProjectDetailsDto) {
    const data: {
      overview?: string | null;
      objectives?: string[];
      category?: ProjectCategory | null;
      origin?: ProjectOrigin | null;
      expectedCompletionDate?: Date | null;
      thumbnail?: string | null;
    } = {};
    if (dto.overview !== undefined) data.overview = dto.overview || null;
    if (dto.objectives !== undefined) data.objectives = dto.objectives;
    if (dto.category !== undefined) data.category = dto.category;
    if (dto.origin !== undefined) data.origin = dto.origin;
    if (dto.expectedCompletionDate !== undefined)
      data.expectedCompletionDate = this.toDate(dto.expectedCompletionDate);
    if (dto.thumbnail !== undefined) data.thumbnail = dto.thumbnail || null;
    return data;
  }

  private async buildWorkspace(
    projectId: string,
    viewer: AuthUser,
    db: Db = this.prisma,
  ): Promise<WorkspaceDto> {
    const project = await this.access.getProjectOrThrow(projectId, db);
    const team = await this.access.getTeamOrThrow(project.teamId, db);
    const members = await this.teamsService.listMembers(team.id, db);
    const supervisors = await this.listSupervisors(project.id, db);
    const viewerMember = members.find((m) => m.userId === viewer.id) ?? null;
    const leader = members.find((m) => m.teamRole === TeamRole.LEADER) ?? null;
    const isLeader = viewerMember?.teamRole === TeamRole.LEADER;

    const [stages, progress, handbook, setupReadiness] = await Promise.all([
      this.loadStages(project.id, db),
      this.loadProgress(project.id),
      this.loadHandbookState(project.id, db),
      this.readiness.evaluate(project.id, db),
    ]);

    return {
      project: this.toProjectView(project),
      team: {
        id: team.id,
        name: team.name,
        universityId: members[0]?.user.universityId ?? null,
        description: team.description,
        avatar: team.avatar,
        memberCount: members.length,
        members,
      },
      leader: leader?.user ?? null,
      supervisors,
      // the invitation code/link is managed by every student of the team
      invitation: viewerMember
        ? this.teamsService.toInvitationView(team)
        : null,
      viewer: {
        role: viewer.role,
        teamRole: viewerMember?.teamRole ?? null,
        isLeader,
        canManage: !!viewerMember,
        isSupervisor:
          viewer.role === UserRole.SUPERVISOR &&
          supervisors.some((s) => s.userId === viewer.id),
        profileComplete: hasUniversityIdentity(viewer),
      },
      progress,
      stages,
      handbook,
      setupReadiness,
    };
  }

  private async loadStages(
    projectId: string,
    db: Db,
  ): Promise<ProjectStageDto[]> {
    const [milestones, counts] = await Promise.all([
      db.milestone.findMany({
        where: { projectId },
        orderBy: STAGE_ORDER_BY,
        select: {
          id: true,
          title: true,
          description: true,
          sortOrder: true,
          dueDate: true,
          status: true,
        },
      }),
      db.task.groupBy({
        by: ['milestoneId', 'status'],
        where: { projectId, milestoneId: { not: null } },
        _count: { _all: true },
        orderBy: { milestoneId: 'asc' },
      }),
    ]);
    const per = new Map<string, { total: number; done: number }>();
    for (const row of counts) {
      if (!row.milestoneId || row.status === TaskStatus.CANCELLED) continue;
      const n = (row._count as { _all?: number } | undefined)?._all ?? 0;
      const p = per.get(row.milestoneId) ?? { total: 0, done: 0 };
      p.total += n;
      if (row.status === TaskStatus.COMPLETED) p.done += n;
      per.set(row.milestoneId, p);
    }
    return milestones.map((m) => {
      const p = per.get(m.id) ?? { total: 0, done: 0 };
      return {
        id: m.id,
        title: m.title,
        description: m.description,
        order: m.sortOrder,
        dueDate: m.dueDate,
        status: m.status,
        totalTasks: p.total,
        completedTasks: p.done,
        percent: p.total ? Math.round((p.done / p.total) * 100) : 0,
      };
    });
  }

  private async loadProgress(projectId: string) {
    const m = (await this.metrics.loadMetrics([projectId])).get(projectId)!;
    return {
      percent: m.progress.percent,
      readinessScore: m.readiness.score,
      readinessLevel: m.readiness.level,
      totalTasks: m.stats.tasks.total,
      completedTasks: m.stats.tasks.completed,
    };
  }

  private async loadHandbookState(
    projectId: string,
    db: Db,
  ): Promise<WorkspaceHandbookDto> {
    const h = await loadEffectiveHandbook(db, projectId);
    return {
      state: h.state,
      source: h.source,
      title: h.title,
      libraryVersion: h.libraryVersion,
    };
  }

  private async listSupervisors(
    projectId: string,
    db: Db,
  ): Promise<ProjectSupervisorDto[]> {
    const rows = await db.projectMember.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: PUBLIC_USER_SELECT } },
    });
    return rows
      .filter((r) => r.user.role === UserRole.SUPERVISOR)
      .map((r) => ({
        userId: r.userId,
        projectRole: r.role,
        linkedAt: r.createdAt,
        user: r.user,
      }));
  }

  toProjectView(p: Project): ProjectViewDto {
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      status: p.status,
      startDate: p.startDate,
      endDate: p.endDate,
      thumbnail: p.thumbnail,
      isPublic: p.isPublic,
      teamId: p.teamId,
      overview: p.overview ?? null,
      objectives: p.objectives ?? [],
      category: p.category ?? null,
      origin: p.origin ?? null,
      expectedCompletionDate: p.expectedCompletionDate ?? null,
      setup: {
        completed: p.setupStep === ProjectSetupStep.COMPLETED,
        step: p.setupStep,
        completedAt: p.setupCompletedAt ?? null,
      },
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  private toDate(value?: string | null): Date | null {
    return value ? new Date(value) : null;
  }

  private assertDateRange(start: Date | null, end: Date | null) {
    if (start && end && end < start) {
      throw new BadRequestException(
        workspaceError(
          E.INVALID_DATE_RANGE,
          'endDate must not be before startDate',
        ),
      );
    }
  }
}
