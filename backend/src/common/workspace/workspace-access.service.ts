import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Project, Team, TeamMember, UserRole } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuthUser } from '@common/types/auth-user.type';
import { WorkspaceErrorCode as E, workspaceError } from './workspace-errors';

type Db = PrismaService | Prisma.TransactionClient;

/**
 * Central authorization rules for project workspaces and teams.
 *
 * - STUDENT: access only the team they belong to (team_members) and its project.
 * - SUPERVISOR: access only projects they are linked to (project_members).
 * - Any other role: no access to workspaces in this stage.
 *
 * TeamRole (LEADER/MEMBER) is display-only and is NEVER checked here.
 */
@Injectable()
export class WorkspaceAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** The student's single team membership (userId is unique), or null. */
  findStudentMembership(
    userId: string,
    db: Db = this.prisma,
  ): Promise<TeamMember | null> {
    return db.teamMember.findUnique({ where: { userId } });
  }

  async getProjectOrThrow(
    projectId: string,
    db: Db = this.prisma,
  ): Promise<Project> {
    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project) {
      throw new NotFoundException(
        workspaceError(E.PROJECT_NOT_FOUND, 'Project not found'),
      );
    }
    return project;
  }

  async getTeamOrThrow(teamId: string, db: Db = this.prisma): Promise<Team> {
    const team = await db.team.findUnique({ where: { id: teamId } });
    if (!team) {
      throw new NotFoundException(
        workspaceError(E.TEAM_NOT_FOUND, 'Team not found'),
      );
    }
    return team;
  }

  async isSupervisorOfProject(
    userId: string,
    projectId: string,
    db: Db = this.prisma,
  ) {
    const link = await db.projectMember.findUnique({
      where: { userId_projectId: { userId, projectId } },
    });
    return !!link;
  }

  /**
   * The team's university = the university of its students.
   * All students of a team share one university (enforced on create/join/add),
   * and a team always keeps at least one member.
   */
  async getTeamUniversityId(
    teamId: string,
    db: Db = this.prisma,
  ): Promise<string | null> {
    const member = await db.teamMember.findFirst({
      where: { teamId },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { universityId: true } } },
    });
    return member?.user.universityId ?? null;
  }

  /** Throws 409 UNIVERSITY_MISMATCH unless both universities are set and equal. */
  assertSameUniversity(
    teamUniversityId: string | null,
    userUniversityId: string | null,
    message: string,
  ) {
    if (
      !teamUniversityId ||
      !userUniversityId ||
      teamUniversityId !== userUniversityId
    ) {
      throw new ConflictException(
        workspaceError(E.UNIVERSITY_MISMATCH, message),
      );
    }
  }

  /**
   * Project ids the user may READ, resolved in one query:
   * - STUDENT: the project of their team (0 or 1)
   * - SUPERVISOR: projects they are linked to as SUPERVISOR (accepted request)
   * - others: none
   */
  async getReadableProjectIds(
    user: AuthUser,
    db: Db = this.prisma,
  ): Promise<string[]> {
    if (user.role === UserRole.STUDENT) {
      const membership = await this.findStudentMembership(user.id, db);
      if (!membership) return [];
      const project = await db.project.findUnique({
        where: { teamId: membership.teamId },
        select: { id: true },
      });
      return project ? [project.id] : [];
    }
    if (user.role === UserRole.SUPERVISOR) {
      const links = await db.projectMember.findMany({
        where: { userId: user.id },
        select: { projectId: true },
      });
      return links.map((l) => l.projectId);
    }
    return [];
  }

  /** True when the user is a STUDENT member of the given project's team. */
  async isStudentOfProjectTeam(
    userId: string,
    projectTeamId: string,
    db: Db = this.prisma,
  ) {
    const membership = await this.findStudentMembership(userId, db);
    return membership?.teamId === projectTeamId;
  }

  /** Read access: the project's own students, or a supervisor linked to it. */
  async assertCanViewProject(
    user: AuthUser,
    projectId: string,
    db: Db = this.prisma,
  ) {
    const project = await this.getProjectOrThrow(projectId, db);

    if (user.role === UserRole.STUDENT) {
      const membership = await this.findStudentMembership(user.id, db);
      if (membership?.teamId === project.teamId) return project;
    } else if (user.role === UserRole.SUPERVISOR) {
      if (await this.isSupervisorOfProject(user.id, project.id, db))
        return project;
    }

    throw new ForbiddenException(
      workspaceError(
        E.PROJECT_ACCESS_DENIED,
        'You do not have access to this project',
      ),
    );
  }

  /** Write access to a project: only students who belong to its team. */
  async assertStudentOfProject(
    user: AuthUser,
    projectId: string,
    db: Db = this.prisma,
  ) {
    const project = await this.getProjectOrThrow(projectId, db);
    const membership =
      user.role === UserRole.STUDENT
        ? await this.findStudentMembership(user.id, db)
        : null;

    if (membership?.teamId !== project.teamId) {
      throw new ForbiddenException(
        workspaceError(
          E.PROJECT_ACCESS_DENIED,
          'Only students of this project team can do this',
        ),
      );
    }
    return project;
  }

  /** Review access to a project: only a SUPERVISOR linked to it (accepted request). */
  async assertSupervisorOfProject(
    user: AuthUser,
    projectId: string,
    db: Db = this.prisma,
  ) {
    const project = await this.getProjectOrThrow(projectId, db);
    const linked =
      user.role === UserRole.SUPERVISOR &&
      (await this.isSupervisorOfProject(user.id, project.id, db));

    if (!linked) {
      throw new ForbiddenException(
        workspaceError(
          E.PROJECT_ACCESS_DENIED,
          "Only this project's supervisor can do this",
        ),
      );
    }
    return project;
  }

  /** User ids of the STUDENT members of a team (notification recipients). */
  async getTeamStudentIds(
    teamId: string,
    db: Db = this.prisma,
  ): Promise<string[]> {
    const members = await db.teamMember.findMany({
      where: { teamId },
      select: { userId: true },
    });
    return members.map((m) => m.userId);
  }

  /** User ids of the supervisors linked to a project (notification recipients). */
  async getProjectSupervisorIds(
    projectId: string,
    db: Db = this.prisma,
  ): Promise<string[]> {
    const links = await db.projectMember.findMany({
      where: { projectId, user: { role: UserRole.SUPERVISOR } },
      select: { userId: true },
    });
    return links.map((l) => l.userId);
  }

  /** Read access to a team: its students, or a supervisor of the team's project. */
  async assertCanViewTeam(
    user: AuthUser,
    teamId: string,
    db: Db = this.prisma,
  ) {
    const team = await this.getTeamOrThrow(teamId, db);

    if (user.role === UserRole.STUDENT) {
      const membership = await this.findStudentMembership(user.id, db);
      if (membership?.teamId === team.id) return team;
    } else if (user.role === UserRole.SUPERVISOR) {
      const project = await db.project.findUnique({
        where: { teamId: team.id },
      });
      if (
        project &&
        (await this.isSupervisorOfProject(user.id, project.id, db))
      )
        return team;
    }

    throw new ForbiddenException(
      workspaceError(
        E.TEAM_ACCESS_DENIED,
        'You do not have access to this team',
      ),
    );
  }

  /** Write access to a team: only students who belong to it (any TeamRole). */
  async assertStudentOfTeam(
    user: AuthUser,
    teamId: string,
    db: Db = this.prisma,
  ) {
    const team = await this.getTeamOrThrow(teamId, db);
    const membership =
      user.role === UserRole.STUDENT
        ? await this.findStudentMembership(user.id, db)
        : null;

    if (membership?.teamId !== team.id) {
      throw new ForbiddenException(
        workspaceError(
          E.TEAM_ACCESS_DENIED,
          'Only students of this team can do this',
        ),
      );
    }
    return team;
  }
}
