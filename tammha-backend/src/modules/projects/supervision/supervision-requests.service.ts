import {
  Optional,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  NotificationType,
  Prisma,
  ProjectRole,
  SupervisionRequestStatus,
  UserRole,
} from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/prisma/prisma.service';
import { readEmailVerificationRequired } from '@modules/auth/email-verification.config';
import { AuthUser } from '@common/types/auth-user.type';
import { WorkspaceAccessService } from '@common/workspace/workspace-access.service';
import {
  WorkspaceErrorCode as E,
  workspaceError,
} from '@common/workspace/workspace-errors';
import { PUBLIC_USER_SELECT } from '@common/workspace/user-select';
import { isUniqueConstraintError } from '@common/utils/prisma-errors.util';
import { emailEquals } from '@common/utils/email.util';
import { PublicUserDto } from '@modules/teams/dto/team-response.dto';
import { SupervisionRequestViewDto } from './dto/supervision-response.dto';
import { NotificationsService } from '@modules/notifications/notifications.service';
import { displayName } from '@modules/users/account.service';

type Db = PrismaService | Prisma.TransactionClient;

const { PENDING, ACCEPTED, REJECTED, CANCELLED } = SupervisionRequestStatus;

/** Role a supervisor gets in project_members when a request is accepted. */
export const SUPERVISOR_PROJECT_ROLE = ProjectRole.PROJECT_MANAGER;

const REQUEST_INCLUDE = {
  project: { select: { id: true, name: true, teamId: true } },
  supervisor: { select: PUBLIC_USER_SELECT },
  requestedBy: { select: PUBLIC_USER_SELECT },
} as const;

/**
 * Supervisor assignment (Option B):
 * the team LEADER sends a request -> the supervisor ACCEPTS or REJECTS (P16: leader only).
 * An accepted supervisor is linked to the project (project_members), never to the team.
 *
 * Rules (MVP):
 * - one accepted supervisor per project
 * - one PENDING request per project at a time (cancel it to ask someone else)
 * - supervisor must belong to the same university as the team
 *
 * Concurrency: every write locks the project row first (UPDATE projects ...),
 * so two requests/acceptances for the same project are serialized by PostgreSQL
 * and the second one sees the first one's committed result.
 */
@Injectable()
export class SupervisionRequestsService {
  /**
   * When account e-mails must be verified (EMAIL_VERIFICATION_REQUIRED), a supervisor is
   * offered to students only after verifying the university e-mail: self-registration proves
   * the address through that link, and an unverified account could not use the product anyway.
   */
  private readonly requireVerifiedSupervisor: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly notifications: NotificationsService,
    @Optional() config?: ConfigService,
  ) {
    this.requireVerifiedSupervisor = readEmailVerificationRequired({
      EMAIL_VERIFICATION_REQUIRED: config?.get<string>(
        'EMAIL_VERIFICATION_REQUIRED',
      ),
      EMAIL_ENABLED: config?.get<string>('EMAIL_ENABLED'),
      NODE_ENV: config?.get<string>('NODE_ENV'),
    }).required;
  }

  // ==========================================================
  // Student side
  // ==========================================================

  /** Active supervisors of the student's university (to choose from). */
  async listAvailableSupervisors(user: AuthUser): Promise<PublicUserDto[]> {
    if (!user.universityId) return [];
    return this.prisma.user.findMany({
      where: {
        role: UserRole.SUPERVISOR,
        isActive: true,
        // self-registered supervisors appear once their university e-mail is verified
        // (admin-created accounts are verified when they are activated)
        ...(this.requireVerifiedSupervisor && {
          emailVerifiedAt: { not: null },
        }),
        universityId: user.universityId,
      },
      select: PUBLIC_USER_SELECT,
      orderBy: { createdAt: 'asc' },
    });
  }

  async createRequest(
    user: AuthUser,
    projectId: string,
    supervisorEmail: string,
    message?: string,
  ): Promise<SupervisionRequestViewDto> {
    return this.prisma.$transaction(async (tx) => {
      const project = await this.access.assertLeaderOfProject(
        user,
        projectId,
        tx,
      );
      await this.lockProject(project.id, tx);

      const supervisor = await tx.user.findFirst({
        where: emailEquals(supervisorEmail),
      });
      if (!supervisor) {
        throw new NotFoundException(
          workspaceError(
            E.USER_NOT_FOUND,
            'No registered user found with this email',
          ),
        );
      }
      if (supervisor.role !== UserRole.SUPERVISOR) {
        throw new BadRequestException(
          workspaceError(
            E.USER_NOT_SUPERVISOR,
            'This user is not a SUPERVISOR',
          ),
        );
      }
      if (!supervisor.isActive) {
        throw new BadRequestException(
          workspaceError(
            E.USER_INACTIVE,
            'This supervisor account is inactive',
          ),
        );
      }
      if (this.requireVerifiedSupervisor && !supervisor.emailVerifiedAt) {
        throw new BadRequestException(
          workspaceError(
            E.SUPERVISOR_NOT_VERIFIED,
            'This supervisor has not verified their university e-mail yet',
          ),
        );
      }

      await this.assertNoSupervisorAssigned(project.id, tx);

      const pending = await tx.supervisionRequest.findFirst({
        where: { projectId: project.id, status: PENDING },
        include: { supervisor: { select: { email: true } } },
      });
      if (pending) {
        throw new ConflictException(
          workspaceError(
            E.REQUEST_ALREADY_PENDING,
            `A supervision request is already pending (sent to ${pending.supervisor.email}). Cancel it before sending a new one.`,
          ),
        );
      }

      this.access.assertSameUniversity(
        await this.access.getTeamUniversityId(project.teamId, tx),
        supervisor.universityId,
        'The supervisor must belong to the same university as the project team',
      );

      const created = await tx.supervisionRequest.create({
        data: {
          projectId: project.id,
          supervisorId: supervisor.id,
          requestedById: user.id,
          message: message || null,
        },
        include: REQUEST_INCLUDE,
      });
      await this.notifications.notify(
        [supervisor.id],
        {
          type: NotificationType.SUPERVISION_REQUESTED,
          title: 'Supervision request',
          message: `${displayName(user.firstName, user.lastName)} asked you to supervise "${project.name}".`,
          data: {
            kind: 'supervision_requested',
            actorName: displayName(user.firstName, user.lastName),
            projectName: project.name,
            requestId: created.id,
            projectId: project.id,
          },
          dedupeKey: `supervision-request:${created.id}`,
          email: true,
        },
        tx,
      );
      return this.toView(created);
    });
  }

  /** Request history of a project (team students, or the project's supervisor). */
  async listProjectRequests(
    user: AuthUser,
    projectId: string,
    status?: SupervisionRequestStatus,
  ): Promise<SupervisionRequestViewDto[]> {
    await this.access.assertCanViewProject(user, projectId);
    const rows = await this.prisma.supervisionRequest.findMany({
      where: { projectId, ...(status && { status }) },
      orderBy: { createdAt: 'desc' },
      include: REQUEST_INCLUDE,
    });
    return rows.map((r) => this.toView(r));
  }

  /** The team LEADER may cancel a PENDING request (P16). */
  async cancelRequest(
    user: AuthUser,
    requestId: string,
  ): Promise<SupervisionRequestViewDto> {
    return this.prisma.$transaction(async (tx) => {
      const request = await this.getRequestOrThrow(requestId, tx);
      await this.access
        .assertLeaderOfProject(user, request.projectId, tx)
        .catch((error: { response?: { code?: string } }) => {
          if (error?.response?.code === E.NOT_TEAM_LEADER) throw error;
          throw new ForbiddenException(
            workspaceError(
              E.REQUEST_ACCESS_DENIED,
              'Only the leader of this project team can cancel it',
            ),
          );
        });
      await this.lockProject(request.projectId, tx);
      await this.transitionFromPending(requestId, CANCELLED, null, tx);
      return this.reload(requestId, tx);
    });
  }

  // ==========================================================
  // Supervisor side
  // ==========================================================

  async listIncoming(
    user: AuthUser,
    status?: SupervisionRequestStatus,
  ): Promise<SupervisionRequestViewDto[]> {
    const rows = await this.prisma.supervisionRequest.findMany({
      where: { supervisorId: user.id, ...(status && { status }) },
      orderBy: { createdAt: 'desc' },
      include: REQUEST_INCLUDE,
    });
    return rows.map((r) => this.toView(r));
  }

  /**
   * ACCEPT in one transaction:
   * lock project -> verify still PENDING, no supervisor yet, same university ->
   * link supervisor via project_members -> mark ACCEPTED -> cancel other pending.
   */
  async acceptRequest(
    user: AuthUser,
    requestId: string,
    note?: string,
  ): Promise<SupervisionRequestViewDto> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const request = await this.getRequestForSupervisorOrThrow(
          user,
          requestId,
          tx,
        );
        await this.lockProject(request.projectId, tx);

        await this.assertNoSupervisorAssigned(request.projectId, tx);

        const project = await this.access.getProjectOrThrow(
          request.projectId,
          tx,
        );
        this.access.assertSameUniversity(
          await this.access.getTeamUniversityId(project.teamId, tx),
          user.universityId,
          'You can only supervise projects of your own university',
        );

        await this.transitionFromPending(requestId, ACCEPTED, note, tx);

        await tx.projectMember.create({
          data: {
            userId: user.id,
            projectId: request.projectId,
            role: SUPERVISOR_PROJECT_ROLE,
          },
        });

        await tx.supervisionRequest.updateMany({
          where: {
            projectId: request.projectId,
            status: PENDING,
            id: { not: requestId },
          },
          data: { status: CANCELLED, respondedAt: new Date() },
        });

        await this.notifyTeam(
          project.id,
          project.teamId,
          user,
          'accepted',
          requestId,
          tx,
        );
        return this.reload(requestId, tx);
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          workspaceError(
            E.SUPERVISOR_ALREADY_ASSIGNED,
            'This project already has a supervisor',
          ),
        );
      }
      throw error;
    }
  }

  async rejectRequest(
    user: AuthUser,
    requestId: string,
    note?: string,
  ): Promise<SupervisionRequestViewDto> {
    return this.prisma.$transaction(async (tx) => {
      const request = await this.getRequestForSupervisorOrThrow(
        user,
        requestId,
        tx,
      );
      await this.lockProject(request.projectId, tx);
      await this.transitionFromPending(requestId, REJECTED, note, tx);
      const project = await this.access.getProjectOrThrow(
        request.projectId,
        tx,
      );
      await this.notifyTeam(
        project.id,
        project.teamId,
        user,
        'rejected',
        requestId,
        tx,
      );
      return this.reload(requestId, tx);
    });
  }

  // ==========================================================
  // Internals
  // ==========================================================

  /** P16: every student of the team learns the supervisor's answer. */
  private async notifyTeam(
    projectId: string,
    teamId: string,
    supervisor: AuthUser,
    outcome: 'accepted' | 'rejected',
    requestId: string,
    db: Db,
  ) {
    const students = await this.access.getTeamStudentIds(teamId, db);
    await this.notifications.notify(
      students,
      {
        type: NotificationType.SUPERVISION_RESPONDED,
        title:
          outcome === 'accepted'
            ? 'Supervisor assigned'
            : 'Supervision request declined',
        message:
          outcome === 'accepted'
            ? `${displayName(supervisor.firstName, supervisor.lastName)} is now supervising your project.`
            : `${displayName(supervisor.firstName, supervisor.lastName)} declined the supervision request.`,
        data: {
          kind: `supervision_${outcome}`,
          requestId,
          projectId,
          actorName: displayName(supervisor.firstName, supervisor.lastName),
        },
        dedupeKey: `supervision-${outcome}:${requestId}`,
        email: true,
      },
      db,
    );
  }

  /**
   * Row-level lock on the project (UPDATE takes a FOR UPDATE lock in PostgreSQL).
   * Concurrent transactions on the same project wait here until the first commits.
   */
  private async lockProject(projectId: string, db: Db) {
    await db.project.update({
      where: { id: projectId },
      data: { updatedAt: new Date() },
    });
  }

  private async assertNoSupervisorAssigned(projectId: string, db: Db) {
    const links = await db.projectMember.findMany({
      where: { projectId },
      include: { user: { select: { role: true } } },
    });
    if (links.some((l) => l.user.role === UserRole.SUPERVISOR)) {
      throw new ConflictException(
        workspaceError(
          E.SUPERVISOR_ALREADY_ASSIGNED,
          'This project already has a supervisor',
        ),
      );
    }
  }

  /** Conditional update: only succeeds if the request is still PENDING. */
  private async transitionFromPending(
    requestId: string,
    status: SupervisionRequestStatus,
    note: string | null | undefined,
    db: Db,
  ) {
    const { count } = await db.supervisionRequest.updateMany({
      where: { id: requestId, status: PENDING },
      data: { status, responseNote: note || null, respondedAt: new Date() },
    });
    if (count === 0) {
      const current = await db.supervisionRequest.findUnique({
        where: { id: requestId },
      });
      throw new ConflictException(
        workspaceError(
          E.REQUEST_NOT_PENDING,
          `This request is no longer pending (current status: ${current?.status ?? 'UNKNOWN'})`,
        ),
      );
    }
  }

  private async getRequestOrThrow(requestId: string, db: Db) {
    const request = await db.supervisionRequest.findUnique({
      where: { id: requestId },
    });
    if (!request) {
      throw new NotFoundException(
        workspaceError(E.REQUEST_NOT_FOUND, 'Supervision request not found'),
      );
    }
    return request;
  }

  private async getRequestForSupervisorOrThrow(
    user: AuthUser,
    requestId: string,
    db: Db,
  ) {
    const request = await this.getRequestOrThrow(requestId, db);
    if (request.supervisorId !== user.id) {
      throw new ForbiddenException(
        workspaceError(
          E.REQUEST_ACCESS_DENIED,
          'This request was not sent to you',
        ),
      );
    }
    return request;
  }

  private async reload(requestId: string, db: Db) {
    const row = await db.supervisionRequest.findUnique({
      where: { id: requestId },
      include: REQUEST_INCLUDE,
    });
    return this.toView(row!);
  }

  private toView(row: {
    id: string;
    status: SupervisionRequestStatus;
    message: string | null;
    responseNote: string | null;
    respondedAt: Date | null;
    createdAt: Date;
    project: { id: string; name: string; teamId: string };
    supervisor: PublicUserDto;
    requestedBy: PublicUserDto;
  }): SupervisionRequestViewDto {
    return {
      id: row.id,
      status: row.status,
      message: row.message,
      responseNote: row.responseNote,
      respondedAt: row.respondedAt,
      createdAt: row.createdAt,
      project: row.project,
      supervisor: row.supervisor,
      requestedBy: row.requestedBy,
    };
  }
}
