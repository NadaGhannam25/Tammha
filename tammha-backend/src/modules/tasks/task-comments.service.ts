import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { NotificationType, Prisma, TeamRole } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuthUser } from '@common/types/auth-user.type';
import { WorkspaceAccessService } from '@common/workspace/workspace-access.service';
import {
  WorkspaceErrorCode as E,
  workspaceError,
} from '@common/workspace/workspace-errors';
import { PUBLIC_USER_SELECT } from '@common/workspace/user-select';
import {
  PaginationDto,
  toPageArgs,
  toPageMeta,
} from '@common/dtos/pagination.dto';
import { NotificationsService } from '@modules/notifications/notifications.service';
import { displayName } from '@modules/users/account.service';
import {
  TaskCommentInputDto,
  TaskCommentPageDto,
  TaskCommentViewDto,
} from './dto/task-comment.dto';

const COMMENT_SELECT = {
  id: true,
  taskId: true,
  content: true,
  authorId: true,
  createdAt: true,
  updatedAt: true,
  author: { select: PUBLIC_USER_SELECT },
} satisfies Prisma.CommentSelect;
type CommentRow = Prisma.CommentGetPayload<{ select: typeof COMMENT_SELECT }>;

const err = (code: string, message: string) => ({ code, message });

/**
 * Comments on a task (the existing Comment model): the team's discussion of one task.
 *  - read: students of the project team and the project's supervisor
 *  - write: students of the project team (supervisors use task feedback instead)
 *  - edit: the author; delete: the author or the team leader
 * The assignee and the task creator are notified in-app (never the author).
 */
@Injectable()
export class TaskCommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(
    user: AuthUser,
    taskId: string,
    query: PaginationDto,
  ): Promise<TaskCommentPageDto> {
    const task = await this.taskOrThrow(taskId);
    await this.access.assertCanViewProject(user, task.projectId);
    const { page, limit, skip, take } = toPageArgs(query);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.comment.count({ where: { taskId } }),
      this.prisma.comment.findMany({
        where: { taskId },
        select: COMMENT_SELECT,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip,
        take,
      }),
    ]);
    return {
      items: rows.map((r) => this.toView(r, task.projectId, user)),
      meta: toPageMeta(page, limit, total),
    };
  }

  async create(
    user: AuthUser,
    taskId: string,
    dto: TaskCommentInputDto,
  ): Promise<TaskCommentViewDto> {
    const task = await this.taskOrThrow(taskId);
    await this.access.assertStudentOfProject(user, task.projectId);
    const content = clean(dto.content);
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.comment.create({
        data: { taskId, authorId: user.id, content },
        select: COMMENT_SELECT,
      });
      const recipients = [task.assignedToId, task.createdById].filter(
        (id): id is string => !!id && id !== user.id,
      );
      if (recipients.length > 0) {
        await this.notifications.notify(
          [...new Set(recipients)],
          {
            type: NotificationType.COMMENT_ADDED,
            title: 'New comment on a task',
            message: `${displayName(user.firstName ?? null, user.lastName ?? null)} commented on "${task.title}".`,
            data: {
              kind: 'task_comment',
              taskId,
              projectId: task.projectId,
              commentId: created.id,
            },
            dedupeKey: `task-comment:${created.id}`,
          },
          tx,
        );
      }
      return created;
    });
    return this.toView(row, task.projectId, user);
  }

  async update(
    user: AuthUser,
    taskId: string,
    commentId: string,
    dto: TaskCommentInputDto,
  ): Promise<TaskCommentViewDto> {
    const { task, comment } = await this.load(taskId, commentId);
    await this.access.assertStudentOfProject(user, task.projectId);
    if (comment.authorId !== user.id) {
      throw new ForbiddenException(
        err('COMMENT_NOT_AUTHOR', 'You can only edit your own comments'),
      );
    }
    const row = await this.prisma.comment.update({
      where: { id: commentId },
      data: { content: clean(dto.content) },
      select: COMMENT_SELECT,
    });
    return this.toView(row, task.projectId, user);
  }

  async remove(
    user: AuthUser,
    taskId: string,
    commentId: string,
  ): Promise<{ deleted: true }> {
    const { task, comment } = await this.load(taskId, commentId);
    const project = await this.access.assertStudentOfProject(
      user,
      task.projectId,
    );
    // any student of the team deletes a comment (every student manages the project alike)
    if (
      comment.authorId !== user.id &&
      !(await this.access.findMembershipInTeam(user.id, project.teamId))
    ) {
      throw new ForbiddenException(
        err(
          'COMMENT_DELETE_NOT_ALLOWED',
          'Only a student of this team can delete a comment',
        ),
      );
    }
    await this.prisma.comment.delete({ where: { id: commentId } });
    return { deleted: true };
  }

  // ---------------------------------------------------------------

  private async taskOrThrow(taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        title: true,
        projectId: true,
        assignedToId: true,
        createdById: true,
      },
    });
    if (!task) {
      throw new NotFoundException(
        workspaceError(E.TASK_NOT_FOUND, 'Task not found'),
      );
    }
    return task;
  }

  private async load(taskId: string, commentId: string) {
    const task = await this.taskOrThrow(taskId);
    const comment = await this.prisma.comment.findFirst({
      where: { id: commentId, taskId },
      select: { id: true, authorId: true },
    });
    if (!comment) {
      throw new NotFoundException(
        err('COMMENT_NOT_FOUND', 'Comment not found'),
      );
    }
    return { task, comment };
  }

  private toView(
    row: CommentRow,
    projectId: string,
    viewer: AuthUser,
  ): TaskCommentViewDto {
    return {
      id: row.id,
      taskId: row.taskId,
      projectId,
      content: row.content,
      author: row.author,
      edited: row.updatedAt.getTime() > row.createdAt.getTime(),
      isMine: row.authorId === viewer.id,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

function clean(content: string): string {
  const value = content.replace(/\r\n/g, '\n').trim();
  if (!value) {
    throw new BadRequestException(
      err('COMMENT_EMPTY', 'Write a comment first'),
    );
  }
  return value;
}
