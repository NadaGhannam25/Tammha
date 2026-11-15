import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { NotificationType, ProjectStatus, UserRole } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuthUser } from '@common/types/auth-user.type';
import { WorkspaceAccessService } from '@common/workspace/workspace-access.service';
import {
  WorkspaceErrorCode as E,
  workspaceError,
} from '@common/workspace/workspace-errors';
import { NotificationsService } from '@modules/notifications/notifications.service';
import {
  ProjectStatusChangeDto,
  UpdateProjectStatusDto,
} from './project-status.dto';

export const STATUS_LABEL: Record<ProjectStatus, string> = {
  PLANNING: 'Planning',
  IN_PROGRESS: 'In progress',
  REVIEW: 'Under review',
  COMPLETED: 'Completed',
  ARCHIVED: 'Archived',
};

/**
 * Who may move a project between statuses:
 *  - The team LEADER (P16): PLANNING <-> IN_PROGRESS <-> REVIEW (REVIEW = submitted for final review)
 *  - The project's supervisor: any status (incl. COMPLETED, ARCHIVED, reopening)
 */
export const STUDENT_TRANSITIONS: Partial<
  Record<ProjectStatus, ProjectStatus[]>
> = {
  PLANNING: [ProjectStatus.IN_PROGRESS],
  IN_PROGRESS: [ProjectStatus.PLANNING, ProjectStatus.REVIEW],
  REVIEW: [ProjectStatus.IN_PROGRESS],
};

@Injectable()
export class ProjectStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly notifications: NotificationsService,
  ) {}

  async changeStatus(
    user: AuthUser,
    projectId: string,
    dto: UpdateProjectStatusDto,
  ): Promise<ProjectStatusChangeDto> {
    const project =
      user.role === UserRole.SUPERVISOR
        ? await this.access.assertSupervisorOfProject(user, projectId)
        : await this.access.assertLeaderOfProject(user, projectId); // P16: team leader

    const from = project.status;
    const to = dto.status;
    if (from === to) {
      throw new ConflictException(
        workspaceError(
          E.PROJECT_STATUS_UNCHANGED,
          `The project is already ${STATUS_LABEL[to].toLowerCase()}`,
        ),
      );
    }
    if (
      user.role !== UserRole.SUPERVISOR &&
      !(STUDENT_TRANSITIONS[from] ?? []).includes(to)
    ) {
      throw new ForbiddenException(
        workspaceError(
          E.PROJECT_STATUS_NOT_ALLOWED,
          `Students cannot change the status from ${STATUS_LABEL[from]} to ${STATUS_LABEL[to]}. Ask your supervisor.`,
        ),
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // compare-and-set: a concurrent change makes this one fail instead of overwriting it
      const { count } = await tx.project.updateMany({
        where: { id: projectId, status: from },
        data: { status: to },
      });
      if (count === 0) {
        throw new ConflictException(
          workspaceError(
            E.PROJECT_STATUS_CONFLICT,
            'The project status was changed by someone else. Reload and try again.',
          ),
        );
      }
      const updated = await tx.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { id: true, name: true, status: true, updatedAt: true },
      });

      const [students, supervisors] = await Promise.all([
        this.access.getTeamStudentIds(project.teamId, tx),
        this.access.getProjectSupervisorIds(projectId, tx),
      ]);
      const note = dto.note ? ` Note: ${dto.note}` : '';
      await this.notifications.notify(
        [...students, ...supervisors].filter((id) => id !== user.id),
        {
          type: NotificationType.PROJECT_STATUS_CHANGED,
          title: 'Project status changed',
          message: `"${updated.name}" moved from ${STATUS_LABEL[from]} to ${STATUS_LABEL[to]}.${note}`,
          data: {
            kind: 'project_status_changed',
            projectName: updated.name,
            projectId,
            from,
            to,
            changedBy: user.id,
          },
          dedupeKey: `project:${projectId}:status:${from}->${to}:${updated.updatedAt.getTime()}`,
          email: true,
        },
        tx,
      );

      return {
        projectId: updated.id,
        name: updated.name,
        previousStatus: from,
        status: updated.status,
        changedAt: updated.updatedAt,
      };
    });
  }
}
