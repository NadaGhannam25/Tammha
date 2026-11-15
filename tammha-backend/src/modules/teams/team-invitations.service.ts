import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  NotificationType,
  Prisma,
  TeamInvitationStatus,
  TeamRole,
} from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuthUser } from '@common/types/auth-user.type';
import { WorkspaceAccessService } from '@common/workspace/workspace-access.service';
import {
  WorkspaceErrorCode as E,
  workspaceError,
} from '@common/workspace/workspace-errors';
import { NotificationsService } from '@modules/notifications/notifications.service';
import { displayName } from '@modules/users/account.service';
import { TeamsService } from './teams.service';
import {
  CreateTeamInvitationDto,
  TeamInvitationViewDto,
} from './dto/team-invitation.dto';
import {
  findStudentByIdentifier,
  pickStudentIdentifier,
} from '@common/identity/student-lookup';

type Db = PrismaService | Prisma.TransactionClient;
const { PENDING, ACCEPTED, DECLINED, CANCELLED } = TeamInvitationStatus;

const INCLUDE = {
  team: { select: { id: true, name: true } },
  invitee: { select: { firstName: true, lastName: true, studentNumber: true } },
  invitedBy: {
    select: { firstName: true, lastName: true, studentNumber: true },
  },
} satisfies Prisma.TeamInvitationInclude;
type Row = Prisma.TeamInvitationGetPayload<{ include: typeof INCLUDE }>;
type ProjectRef = { id: string; name: string } | null;

/**
 * P16: direct team invitations. The team LEADER invites a classmate by student number;
 * the student accepts (joins as MEMBER) or declines. The invitation code/link stays
 * available as a second way to join. One pending invitation per (team, student).
 */
@Injectable()
export class TeamInvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly teams: TeamsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** The leader invites a classmate by student number OR verified university e-mail. */
  async invite(
    user: AuthUser,
    teamId: string,
    dto: CreateTeamInvitationDto,
  ): Promise<TeamInvitationViewDto> {
    const identifier = pickStudentIdentifier(dto);
    const message = dto.message;
    return this.prisma.$transaction(async (tx) => {
      const team = await this.access.assertLeaderOfTeam(user, teamId, tx);
      await this.lockTeam(team.id, tx);

      const universityId = await this.access.getTeamUniversityId(team.id, tx);
      const invitee = await findStudentByIdentifier(
        tx,
        universityId,
        identifier,
      );
      if (!invitee) {
        throw new NotFoundException(
          workspaceError(
            E.STUDENT_NOT_FOUND,
            'No student with this identifier was found at your university',
          ),
        );
      }
      if (invitee.id === user.id) {
        throw new BadRequestException(
          workspaceError(
            E.CANNOT_INVITE_YOURSELF,
            'You cannot invite yourself',
          ),
        );
      }
      await this.teams.assertCanJoin(invitee.id, team.id, tx, 'target');

      const pending = await tx.teamInvitation.findFirst({
        where: { teamId: team.id, inviteeId: invitee.id, status: PENDING },
        select: { id: true },
      });
      if (pending) {
        throw new ConflictException(
          workspaceError(
            E.INVITATION_ALREADY_PENDING,
            'This student already has a pending invitation to your team',
          ),
        );
      }

      const created = await tx.teamInvitation.create({
        data: {
          teamId: team.id,
          inviteeId: invitee.id,
          invitedById: user.id,
          message: message || null,
        },
        include: INCLUDE,
      });
      await this.notifications.notify(
        [invitee.id],
        {
          type: NotificationType.TEAM_INVITATION,
          title: 'Team invitation',
          message: `${displayName(user.firstName, user.lastName)} invited you to join "${team.name}".`,
          data: {
            kind: 'team_invitation',
            teamName: team.name,
            actorName: displayName(user.firstName, user.lastName),
            invitationId: created.id,
            teamId: team.id,
          },
          dedupeKey: `team-invitation:${created.id}`,
          email: true,
        },
        tx,
      );
      return (await this.toViews([created], tx))[0];
    });
  }

  /** Invitations of a team (any student of the team). */
  async listForTeam(
    user: AuthUser,
    teamId: string,
    status?: TeamInvitationStatus,
  ): Promise<TeamInvitationViewDto[]> {
    await this.access.assertStudentOfTeam(user, teamId);
    const rows = await this.prisma.teamInvitation.findMany({
      where: { teamId, ...(status && { status }) },
      include: INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    return this.toViews(rows);
  }

  /** Invitations received by the signed-in student. */
  async listMine(
    user: AuthUser,
    status?: TeamInvitationStatus,
  ): Promise<TeamInvitationViewDto[]> {
    const rows = await this.prisma.teamInvitation.findMany({
      where: { inviteeId: user.id, ...(status && { status }) },
      include: INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    return this.toViews(rows);
  }

  /** Invitee joins the team as MEMBER (same checks as the invitation code). */
  async accept(user: AuthUser, invitationId: string) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const invitation = await this.getForInvitee(user, invitationId, tx);
        await this.lockTeam(invitation.teamId, tx);
        const project = await tx.project.findUnique({
          where: { teamId: invitation.teamId },
          select: { id: true },
        });
        const team = await tx.team.findUnique({
          where: { id: invitation.teamId },
        });
        if (!team?.isActive || !project) {
          throw new ConflictException(
            workspaceError(
              E.INVITATION_INVALID,
              'This team is no longer available',
            ),
          );
        }
        await this.teams.assertCanJoin(user.id, team.id, tx, 'self');
        this.access.assertSameUniversity(
          await this.access.getTeamUniversityId(team.id, tx),
          user.universityId,
          'You cannot join this team because it belongs to a different university',
        );
        await this.transition(invitation.id, ACCEPTED, tx);
        await tx.teamMember.create({
          data: { teamId: team.id, userId: user.id, role: TeamRole.MEMBER },
        });
        // invitations to OTHER teams stay open: a student can work on several projects
        await this.notifyLeader(team.id, user, 'accepted', invitation.id, tx);
        return {
          message: 'Joined team successfully',
          teamId: team.id,
          projectId: project.id,
        };
      });
    } catch (error) {
      throw this.teams.mapJoinRace(error);
    }
  }

  async decline(
    user: AuthUser,
    invitationId: string,
  ): Promise<TeamInvitationViewDto> {
    return this.prisma.$transaction(async (tx) => {
      const invitation = await this.getForInvitee(user, invitationId, tx);
      await this.transition(invitation.id, DECLINED, tx);
      await this.notifyLeader(
        invitation.teamId,
        user,
        'declined',
        invitation.id,
        tx,
      );
      return this.reload(invitation.id, tx);
    });
  }

  /** The team leader withdraws a pending invitation. */
  async cancel(
    user: AuthUser,
    invitationId: string,
  ): Promise<TeamInvitationViewDto> {
    return this.prisma.$transaction(async (tx) => {
      const invitation = await this.getOrThrow(invitationId, tx);
      await this.access.assertLeaderOfTeam(user, invitation.teamId, tx);
      await this.transition(invitation.id, CANCELLED, tx);
      return this.reload(invitation.id, tx);
    });
  }

  // ---------------------------------------------------------------

  private async lockTeam(teamId: string, db: Db) {
    // row lock: concurrent invitations/joins of one team are serialised
    await db.team.update({
      where: { id: teamId },
      data: { updatedAt: new Date() },
    });
  }

  private async getOrThrow(invitationId: string, db: Db) {
    const row = await db.teamInvitation.findUnique({
      where: { id: invitationId },
    });
    if (!row) {
      throw new NotFoundException(
        workspaceError(E.INVITATION_NOT_FOUND, 'Invitation not found'),
      );
    }
    return row;
  }

  /** Someone else's invitation is reported as not found. */
  private async getForInvitee(user: AuthUser, invitationId: string, db: Db) {
    const row = await this.getOrThrow(invitationId, db);
    if (row.inviteeId !== user.id) {
      throw new NotFoundException(
        workspaceError(E.INVITATION_NOT_FOUND, 'Invitation not found'),
      );
    }
    return row;
  }

  private async transition(id: string, status: TeamInvitationStatus, db: Db) {
    const { count } = await db.teamInvitation.updateMany({
      where: { id, status: PENDING },
      data: { status, respondedAt: new Date() },
    });
    if (count === 0) {
      throw new ConflictException(
        workspaceError(
          E.INVITATION_NOT_PENDING,
          'This invitation is no longer pending',
        ),
      );
    }
  }

  private async notifyLeader(
    teamId: string,
    student: AuthUser,
    outcome: 'accepted' | 'declined',
    invitationId: string,
    db: Db,
  ) {
    const leaderId = await this.access.getTeamLeaderId(teamId, db);
    if (!leaderId || leaderId === student.id) return;
    await this.notifications.notify(
      [leaderId],
      {
        type: NotificationType.TEAM_INVITATION,
        title:
          outcome === 'accepted'
            ? 'Invitation accepted'
            : 'Invitation declined',
        message: `${displayName(student.firstName, student.lastName)} ${outcome} your team invitation.`,
        data: {
          kind: `team_invitation_${outcome}`,
          invitationId,
          teamId,
          actorName: displayName(student.firstName, student.lastName),
        },
        dedupeKey: `team-invitation-${outcome}:${invitationId}`,
        email: true,
      },
      db,
    );
  }

  private async reload(id: string, db: Db) {
    const row = await db.teamInvitation.findUnique({
      where: { id },
      include: INCLUDE,
    });
    if (!row) throw new ForbiddenException();
    return (await this.toViews([row], db))[0];
  }

  /** One query for the projects of all teams in the list (no N+1). */
  private async toViews(rows: Row[], db: Db = this.prisma) {
    const projects = await db.project.findMany({
      where: { teamId: { in: [...new Set(rows.map((r) => r.teamId))] } },
      select: { id: true, name: true, teamId: true },
    });
    const byTeam = new Map(projects.map((p) => [p.teamId, p]));
    return rows.map((r) => this.toView(r, byTeam.get(r.teamId) ?? null));
  }

  private toView(row: Row, project: ProjectRef): TeamInvitationViewDto {
    return {
      id: row.id,
      status: row.status,
      message: row.message,
      team: {
        id: row.team.id,
        name: row.team.name,
        projectId: project?.id ?? null,
        projectName: project?.name ?? null,
      },
      invitee: {
        displayName: displayName(row.invitee.firstName, row.invitee.lastName),
        studentNumber: row.invitee.studentNumber,
      },
      invitedBy: {
        displayName: displayName(
          row.invitedBy.firstName,
          row.invitedBy.lastName,
        ),
        studentNumber: row.invitedBy.studentNumber,
      },
      createdAt: row.createdAt,
      respondedAt: row.respondedAt,
    };
  }
}
