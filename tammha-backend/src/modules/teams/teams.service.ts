import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, TaskStatus, Team, TeamRole, UserRole } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuthUser } from '@common/types/auth-user.type';
import { WorkspaceAccessService } from '@common/workspace/workspace-access.service';
import {
  WorkspaceErrorCode as E,
  workspaceError,
} from '@common/workspace/workspace-errors';
import { PUBLIC_USER_SELECT } from '@common/workspace/user-select';
import { isUniqueConstraintError } from '@common/utils/prisma-errors.util';
import { emailEquals } from '@common/utils/email.util';
import {
  buildInvitationLink,
  generateInvitationCode,
  normalizeInvitationInput,
} from '@common/utils/invitation-code.util';
import { UpdateTeamDto } from './dto/update-team.dto';
import {
  InvitationPreviewDto,
  InvitationViewDto,
  JoinTeamResultDto,
  TeamMemberViewDto,
  TeamViewDto,
} from './dto/team-response.dto';
import {
  hasUniversityIdentity,
  targetIdentityMissing, assertUniversityIdentity } from '@common/identity/university-identity';

const IDENTITY_SELECT = {
  role: true,
  universityId: true,
  studentNumber: true,
  universityEmail: true,
  universityEmailVerifiedAt: true,
} as const;

type Db = PrismaService | Prisma.TransactionClient;

const DEFAULT_INVITATION_BASE_URL = 'http://localhost:5173/join.html?code=';
const MAX_CODE_ATTEMPTS = 10;

@Injectable()
export class TeamsService {
  private readonly invitationBaseUrl: string;
  private readonly maxMembers: number | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    configService: ConfigService,
  ) {
    this.invitationBaseUrl = configService.get<string>(
      'INVITATION_LINK_BASE_URL',
      DEFAULT_INVITATION_BASE_URL,
    );
    const max = parseInt(
      configService.get<string>('TEAM_MAX_MEMBERS') ?? '',
      10,
    );
    this.maxMembers = Number.isFinite(max) && max > 0 ? max : null;
  }

  // ==========================================================
  // Shared helpers (also used by ProjectsService)
  // ==========================================================

  /** Generates a code that is not used by any team yet. */
  async generateUniqueInviteCode(db: Db = this.prisma): Promise<string> {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      const code = generateInvitationCode();
      const existing = await db.team.findUnique({
        where: { inviteCode: code },
        select: { id: true },
      });
      if (!existing) return code;
    }
    throw new InternalServerErrorException(
      'Could not generate a unique invitation code',
    );
  }

  toInvitationView(
    team: Pick<Team, 'inviteCode' | 'inviteCodeUpdatedAt'>,
  ): InvitationViewDto | null {
    if (!team.inviteCode) return null;
    return {
      code: team.inviteCode,
      link: buildInvitationLink(this.invitationBaseUrl, team.inviteCode),
      updatedAt: team.inviteCodeUpdatedAt,
    };
  }

  /** Team members (students), oldest first, with public user fields only. */
  async listMembers(
    teamId: string,
    db: Db = this.prisma,
  ): Promise<TeamMemberViewDto[]> {
    const rows = await db.teamMember.findMany({
      where: { teamId },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: PUBLIC_USER_SELECT } },
    });
    return rows.map((m) => ({
      userId: m.userId,
      teamRole: m.role,
      joinedAt: m.createdAt,
      user: m.user,
    }));
  }

  async buildTeamView(team: Team, db: Db = this.prisma): Promise<TeamViewDto> {
    const members = await this.listMembers(team.id, db);
    const project = await db.project.findUnique({
      where: { teamId: team.id },
      select: { id: true },
    });
    return {
      id: team.id,
      name: team.name,
      description: team.description,
      avatar: team.avatar,
      isActive: team.isActive,
      projectId: project?.id ?? null,
      universityId: await this.access.getTeamUniversityId(team.id, db),
      memberCount: members.length,
      members,
    };
  }

  // ==========================================================
  // Team endpoints
  // ==========================================================

  /** All teams of the current student (one per project), most recently joined first. */
  async listMyTeams(user: AuthUser): Promise<TeamViewDto[]> {
    const memberships = await this.access.findStudentMemberships(user.id);
    const result: TeamViewDto[] = [];
    for (const m of memberships) {
      result.push(
        await this.buildTeamView(await this.access.getTeamOrThrow(m.teamId)),
      );
    }
    return result;
  }

  /** The most recently joined team (GET /teams lists all of them). */
  async getMyTeam(user: AuthUser): Promise<TeamViewDto> {
    const [membership] = await this.access.findStudentMemberships(user.id);
    if (!membership) {
      throw new NotFoundException(
        workspaceError(E.NOT_IN_TEAM, 'You are not a member of any team yet'),
      );
    }
    const team = await this.access.getTeamOrThrow(membership.teamId);
    return this.buildTeamView(team);
  }

  async updateTeam(
    user: AuthUser,
    teamId: string,
    dto: UpdateTeamDto,
  ): Promise<TeamViewDto> {
    await this.access.assertLeaderOfTeam(user, teamId);

    const data: Prisma.TeamUpdateInput = {};
    if (typeof dto.name === 'string') data.name = dto.name;
    if (dto.description !== undefined)
      data.description = dto.description || null;

    const team = await this.prisma.team.update({ where: { id: teamId }, data });
    return this.buildTeamView(team);
  }

  async getMembers(
    user: AuthUser,
    teamId: string,
  ): Promise<TeamMemberViewDto[]> {
    await this.access.assertCanViewTeam(user, teamId);
    return this.listMembers(teamId);
  }

  /** Adds a registered STUDENT (by email) who is not in any team yet. */
  async addMember(
    user: AuthUser,
    teamId: string,
    email: string,
  ): Promise<TeamMemberViewDto[]> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.access.assertLeaderOfTeam(user, teamId, tx);

        const target = await tx.user.findFirst({ where: emailEquals(email) });
        if (!target) {
          throw new NotFoundException(
            workspaceError(
              E.USER_NOT_FOUND,
              'No registered user found with this email',
            ),
          );
        }
        if (target.role !== UserRole.STUDENT) {
          throw new BadRequestException(
            workspaceError(
              E.USER_NOT_STUDENT,
              'Only STUDENT accounts can be team members',
            ),
          );
        }
        if (!target.isActive) {
          throw new BadRequestException(
            workspaceError(E.USER_INACTIVE, 'This user account is inactive'),
          );
        }

        await this.assertCanJoin(target.id, teamId, tx, 'target');
        this.access.assertSameUniversity(
          await this.access.getTeamUniversityId(teamId, tx),
          target.universityId,
          'This student belongs to a different university than the team',
        );

        await tx.teamMember.create({
          data: { teamId, userId: target.id, role: TeamRole.MEMBER },
        });
        return this.listMembers(teamId, tx);
      });
    } catch (error) {
      throw this.mapJoinRace(error);
    }
  }

  /**
   * Removes a member. Only the LEADER removes others; any student may remove
   * themselves (leave the team). The last member cannot be removed. When the
   * leader leaves, the earliest remaining member becomes the leader.
   */
  async removeMember(user: AuthUser, teamId: string, targetUserId: string) {
    return this.prisma.$transaction(async (tx) => {
      if (targetUserId === user.id) {
        await this.access.assertStudentOfTeam(user, teamId, tx);
      } else {
        await this.access.assertLeaderOfTeam(user, teamId, tx);
        // the project's owner is never removed by another member
        if (await this.access.isLeaderOfTeam(targetUserId, teamId, tx)) {
          throw new ForbiddenException(
            workspaceError(
              E.NOT_TEAM_LEADER,
              'The project owner cannot be removed by another member',
            ),
          );
        }
      }

      const target = await tx.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId: targetUserId } },
      });
      if (!target || target.teamId !== teamId) {
        throw new NotFoundException(
          workspaceError(
            E.MEMBER_NOT_FOUND,
            'This user is not a member of this team',
          ),
        );
      }

      const count = await tx.teamMember.count({ where: { teamId } });
      if (count <= 1) {
        throw new ConflictException(
          workspaceError(
            E.LAST_MEMBER,
            'The last member cannot be removed. A team must keep at least one student.',
          ),
        );
      }

      await tx.teamMember.delete({ where: { id: target.id } });

      // A former member can no longer access the project: unassign their tasks
      // in this project (completed ones keep their history).
      const project = await tx.project.findUnique({
        where: { teamId },
        select: { id: true },
      });
      if (project) {
        await tx.task.updateMany({
          where: {
            projectId: project.id,
            assignedToId: targetUserId,
            status: { not: TaskStatus.COMPLETED },
          },
          data: { assignedToId: null },
        });
      }

      if (target.role === TeamRole.LEADER) {
        // earliest remaining member WITH a university identity; if nobody has one,
        // the earliest member (leader actions stay blocked until they add one)
        const remaining = await tx.teamMember.findMany({
          where: { teamId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          include: { user: { select: IDENTITY_SELECT } },
        });
        const next =
          remaining.find((m) => hasUniversityIdentity(m.user)) ?? remaining[0];
        if (next) {
          await tx.teamMember.update({
            where: { id: next.id },
            data: { role: TeamRole.LEADER },
          });
        }
      }

      return {
        message:
          targetUserId === user.id
            ? 'You left the team'
            : 'Member removed from the team',
        members: await this.listMembers(teamId, tx),
      };
    });
  }

  /** The current LEADER hands leadership (and its permissions) to another member. */
  async setLeader(user: AuthUser, teamId: string, targetUserId: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.access.assertOwnerOfTeam(user, teamId, tx);
      assertUniversityIdentity(user);

      const target = await tx.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId: targetUserId } },
        include: { user: { select: IDENTITY_SELECT } },
      });
      if (!target || target.teamId !== teamId) {
        throw new NotFoundException(
          workspaceError(
            E.MEMBER_NOT_FOUND,
            'This user is not a member of this team',
          ),
        );
      }
      // the new leader needs a student number or a verified university e-mail
      if (!hasUniversityIdentity(target.user)) throw targetIdentityMissing();

      await tx.teamMember.updateMany({
        where: { teamId, role: TeamRole.LEADER },
        data: { role: TeamRole.MEMBER },
      });
      await tx.teamMember.update({
        where: { id: target.id },
        data: { role: TeamRole.LEADER },
      });
      return this.listMembers(teamId, tx);
    });
  }

  // ==========================================================
  // Invitations
  // ==========================================================

  /** Returns the team's code + link, creating a code if the team has none yet. */
  async getInvitation(
    user: AuthUser,
    teamId: string,
  ): Promise<InvitationViewDto> {
    const team = await this.access.assertLeaderOfTeam(user, teamId);
    const existing = this.toInvitationView(team);
    return existing ?? this.writeNewInviteCode(teamId);
  }

  /** Replaces the code. The previous code and link stop working immediately. */
  async regenerateInvitation(
    user: AuthUser,
    teamId: string,
  ): Promise<InvitationViewDto> {
    await this.access.assertLeaderOfTeam(user, teamId);
    return this.writeNewInviteCode(teamId);
  }

  /** Shows which team/project an invitation belongs to, before joining. */
  async previewInvitation(input: string): Promise<InvitationPreviewDto> {
    const code = this.parseInvitationOrThrow(input);
    const { team, project } = await this.resolveInvitationOrThrow(
      code,
      this.prisma,
    );
    const memberCount = await this.prisma.teamMember.count({
      where: { teamId: team.id },
    });
    return {
      code,
      teamId: team.id,
      teamName: team.name,
      projectId: project.id,
      projectName: project.name,
      memberCount,
      maxMembers: this.maxMembers,
    };
  }

  /** STUDENT joins the team (and therefore its project) behind a valid invitation. */
  async joinByInvitation(
    user: AuthUser,
    input: string,
  ): Promise<JoinTeamResultDto> {
    const code = this.parseInvitationOrThrow(input);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const { team, project } = await this.resolveInvitationOrThrow(code, tx);
        await this.assertCanJoin(user.id, team.id, tx, 'self');
        this.access.assertSameUniversity(
          await this.access.getTeamUniversityId(team.id, tx),
          user.universityId,
          'You cannot join this team because it belongs to a different university',
        );

        await tx.teamMember.create({
          data: { teamId: team.id, userId: user.id, role: TeamRole.MEMBER },
        });

        return {
          message: 'Joined team successfully',
          teamId: team.id,
          projectId: project.id,
        };
      });
    } catch (error) {
      throw this.mapJoinRace(error);
    }
  }

  // ==========================================================
  // Internals
  // ==========================================================

  private parseInvitationOrThrow(input: string): string {
    const code = normalizeInvitationInput(input);
    if (!code) {
      throw new BadRequestException(
        workspaceError(
          E.INVITATION_MALFORMED,
          'Invitation code format is invalid. Expected 8 letters/digits or a valid invitation link.',
        ),
      );
    }
    return code;
  }

  private async resolveInvitationOrThrow(code: string, db: Db) {
    const team = await db.team.findUnique({ where: { inviteCode: code } });
    const project = team?.isActive
      ? await db.project.findUnique({ where: { teamId: team.id } })
      : null;

    if (!team || !project) {
      throw new NotFoundException(
        workspaceError(
          E.INVITATION_INVALID,
          'This invitation is invalid or has been replaced. Ask your team for a new code.',
        ),
      );
    }
    return { team, project };
  }

  /**
   * A student can be in several teams (one per project), but never twice in the same
   * team; plus the optional team size limit.
   */
  async assertCanJoin(
    userId: string,
    teamId: string,
    db: Db,
    who: 'self' | 'target',
  ) {
    if (await this.access.findMembershipInTeam(userId, teamId, db)) {
      throw new ConflictException(
        workspaceError(
          E.ALREADY_IN_THIS_TEAM,
          who === 'self'
            ? 'You are already a member of this team'
            : 'This student is already a member of this team',
        ),
      );
    }

    if (this.maxMembers !== null) {
      const count = await db.teamMember.count({ where: { teamId } });
      if (count >= this.maxMembers) {
        throw new ConflictException(
          workspaceError(
            E.TEAM_FULL,
            `This team is full (maximum ${this.maxMembers} members)`,
          ),
        );
      }
    }
  }

  private async writeNewInviteCode(teamId: string): Promise<InvitationViewDto> {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      try {
        const team = await this.prisma.team.update({
          where: { id: teamId },
          data: {
            inviteCode: await this.generateUniqueInviteCode(),
            inviteCodeUpdatedAt: new Date(),
          },
        });
        return this.toInvitationView(team)!;
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        // Rare collision between the uniqueness check and the write: retry.
      }
    }
    throw new InternalServerErrorException(
      'Could not generate a unique invitation code',
    );
  }

  /** A concurrent join can hit team_members [teamId, userId] @unique: report it clearly. */
  mapJoinRace(error: unknown) {
    if (isUniqueConstraintError(error)) {
      return new ConflictException(
        workspaceError(
          E.ALREADY_IN_THIS_TEAM,
          'This student is already a member of this team',
        ),
      );
    }
    return error;
  }
}
