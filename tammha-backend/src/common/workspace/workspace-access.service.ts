import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  Project,
  Team,
  TeamMember,
  TeamRole,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuthUser } from '@common/types/auth-user.type';
import { WorkspaceErrorCode as E, workspaceError } from './workspace-errors';
import { assertUniversityIdentity } from '@common/identity/university-identity';

type Db = PrismaService | Prisma.TransactionClient;

/**
 * Central authorization rules for project workspaces and teams.
 *
 * - STUDENT: access only the teams they belong to (team_members) and their projects.
 *   A student may belong to several teams, i.e. work on several projects; every check
 *   is made against the membership in THAT project's team, so projects stay separate.
 * - SUPERVISOR: access only projects they are linked to (project_members).
 * - Any other role: no access to workspaces.
 *
 * P16: TeamRole grants permissions. The team LEADER (a STUDENT) manages the team,
 * invitations, the supervisor request, project details and setup, tasks, milestones
 * and the project handbook (assertLeaderOf*). MEMBERS read the project and work on
 * the tasks assigned to them. Supervisors monitor and review, never manage the team.
 */
@Injectable()
export class WorkspaceAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** The student's membership in ONE team (team + user is unique), or null. */
  findMembershipInTeam(
    userId: string,
    teamId: string,
    db: Db = this.prisma,
  ): Promise<TeamMember | null> {
    return db.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
  }

  /** All team memberships of a student, most recent first (one per project). */
  findStudentMemberships(
    userId: string,
    db: Db = this.prisma,
  ): Promise<TeamMember[]> {
    return db.teamMember.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
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
   * - STUDENT: the projects of all their teams
   * - SUPERVISOR: projects they are linked to as SUPERVISOR (accepted request)
   * - others: none
   */
  async getReadableProjectIds(
    user: AuthUser,
    db: Db = this.prisma,
  ): Promise<string[]> {
    if (user.role === UserRole.STUDENT) {
      const memberships = await this.findStudentMemberships(user.id, db);
      if (memberships.length === 0) return [];
      const projects = await db.project.findMany({
        where: { teamId: { in: memberships.map((m) => m.teamId) } },
        select: { id: true },
      });
      return projects.map((p) => p.id);
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
    return !!(await this.findMembershipInTeam(userId, projectTeamId, db));
  }

  /** Read access: the project's own students, or a supervisor linked to it. */
  async assertCanViewProject(
    user: AuthUser,
    projectId: string,
    db: Db = this.prisma,
  ) {
    const project = await this.getProjectOrThrow(projectId, db);

    if (user.role === UserRole.STUDENT) {
      if (await this.findMembershipInTeam(user.id, project.teamId, db))
        return project;
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
        ? await this.findMembershipInTeam(user.id, project.teamId, db)
        : null;

    if (!membership) {
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
      if (await this.findMembershipInTeam(user.id, team.id, db)) return team;
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
        ? await this.findMembershipInTeam(user.id, team.id, db)
        : null;

    if (!membership) {
      throw new ForbiddenException(
        workspaceError(
          E.TEAM_ACCESS_DENIED,
          'Only students of this team can do this',
        ),
      );
    }
    return team;
  }

  // ==========================================================
  // P16: team leader
  // ==========================================================

  /** The project's team leader (user id), or null if the team has none. */
  async getTeamLeaderId(
    teamId: string,
    db: Db = this.prisma,
  ): Promise<string | null> {
    const leader = await db.teamMember.findFirst({
      where: { teamId, role: TeamRole.LEADER },
      select: { userId: true },
    });
    return leader?.userId ?? null;
  }

  /** True when the user is the LEADER of the given team. */
  async isLeaderOfTeam(userId: string, teamId: string, db: Db = this.prisma) {
    const membership = await this.findMembershipInTeam(userId, teamId, db);
    return membership?.role === TeamRole.LEADER;
  }

  /**
   * Management access to a team: only its LEADER, who must also have a university
   * identity (student number or verified university e-mail).
   * Non-members get 403 TEAM_ACCESS_DENIED; members get 403 NOT_TEAM_LEADER; a leader
   * without a university identity gets 403 UNIVERSITY_IDENTITY_REQUIRED.
   */
  async assertLeaderOfTeam(
    user: AuthUser,
    teamId: string,
    db: Db = this.prisma,
  ): Promise<Team> {
    const team = await this.assertStudentOfTeam(user, teamId, db);
    if (!(await this.isLeaderOfTeam(user.id, team.id, db))) {
      throw new ForbiddenException(
        workspaceError(E.NOT_TEAM_LEADER, 'Only the team leader can do this'),
      );
    }
    assertUniversityIdentity(user);
    return team;
  }

  /**
   * Management access to a project: only the LEADER of its team, with a university
   * identity. Non-members (and supervisors) get 403 PROJECT_ACCESS_DENIED; members get
   * 403 NOT_TEAM_LEADER; a leader without identity 403 UNIVERSITY_IDENTITY_REQUIRED.
   */
  async assertLeaderOfProject(
    user: AuthUser,
    projectId: string,
    db: Db = this.prisma,
  ): Promise<Project> {
    const project = await this.assertLeaderMembershipOfProject(
      user,
      projectId,
      db,
    );
    assertUniversityIdentity(user);
    return project;
  }

  /**
   * The LEADER of the project's team, WITHOUT the university-identity gate. Only for
   * Complete Project Setup, which reports a missing identity among its readiness
   * requirements (422 PROJECT_SETUP_INCOMPLETE) instead of failing early.
   */
  async assertLeaderMembershipOfProject(
    user: AuthUser,
    projectId: string,
    db: Db = this.prisma,
  ): Promise<Project> {
    const project = await this.assertStudentOfProject(user, projectId, db);
    if (!(await this.isLeaderOfTeam(user.id, project.teamId, db))) {
      throw new ForbiddenException(
        workspaceError(E.NOT_TEAM_LEADER, 'Only the team leader can do this'),
      );
    }
    return project;
  }
}
