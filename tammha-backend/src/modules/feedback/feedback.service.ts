import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  FeedbackCategory,
  NotificationType,
  Prisma,
  SubmissionStatus,
} from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuthUser } from '@common/types/auth-user.type';
import { WorkspaceAccessService } from '@common/workspace/workspace-access.service';
import {
  WorkspaceErrorCode as E,
  workspaceError,
} from '@common/workspace/workspace-errors';
import { PUBLIC_USER_SELECT } from '@common/workspace/user-select';
import { toPageArgs, toPageMeta } from '@common/dtos/pagination.dto';
import { NotificationsService } from '@modules/notifications/notifications.service';
import {
  CreateFeedbackDto,
  FeedbackQueryDto,
  UpdateFeedbackDto,
  UpdateSubmissionStatusDto,
} from './dto/feedback.dto';
import { FeedbackPageDto, FeedbackViewDto } from './dto/feedback-response.dto';

type Db = PrismaService | Prisma.TransactionClient;

const FEEDBACK_SELECT = {
  id: true,
  projectId: true,
  documentId: true,
  documentVersion: true,
  givenById: true,
  comment: true,
  category: true,
  taskId: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  givenBy: { select: PUBLIC_USER_SELECT },
  document: { select: { id: true, title: true } },
  task: { select: { id: true, title: true } },
} satisfies Prisma.FeedbackSelect;

type FeedbackRow = Prisma.FeedbackGetPayload<{
  select: typeof FEEDBACK_SELECT;
}>;

/** Review decisions that are also sent by email (P11). UNDER_REVIEW stays in-app only. */
const STATUS_LABEL: Record<SubmissionStatus, string> = {
  UPLOADED: 'uploaded',
  SUBMITTED: 'submitted',
  UNDER_REVIEW: 'under review',
  CHANGES_REQUESTED: 'changes requested',
  APPROVED: 'approved',
  REJECTED: 'rejected',
};

/**
 * Supervisor written feedback (on a project, a document or a task) and submission
 * status (review decisions). Tammha does not grade students: no scores or rubrics.
 *
 * - Write (create, edit own, change status): the SUPERVISOR linked to the project.
 *   Feedback on a task never creates, assigns or changes the task.
 * - Read: students of the project team and its supervisor.
 * - Every review decision is stored as a feedback item (immutable status), so the
 *   feedback list is also the review history; the document keeps the current status.
 * - Students are notified (notification records) in the same transaction.
 */
@Injectable()
export class FeedbackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly notifications: NotificationsService,
  ) {}

  // ==========================================================
  // Writes (supervisor of the project)
  // ==========================================================

  async create(
    user: AuthUser,
    dto: CreateFeedbackDto,
  ): Promise<FeedbackViewDto> {
    const target = await this.resolveTarget(
      dto.projectId,
      dto.documentId,
      dto.taskId,
    );
    const project = await this.access.assertSupervisorOfProject(
      user,
      target.projectId,
    );

    if (dto.status && !target.document) {
      throw new BadRequestException(
        workspaceError(
          E.STATUS_REQUIRES_DOCUMENT,
          'A submission status can only be set on a document',
        ),
      );
    }
    const content = normalizeContent(dto);
    if (!content.comment && !dto.status) {
      throw new BadRequestException(
        workspaceError(
          E.FEEDBACK_EMPTY,
          target.task
            ? 'Write your feedback on the task'
            : 'Send at least a comment or a status',
        ),
      );
    }

    const id = await this.prisma.$transaction(async (tx) => {
      let documentVersion: number | null = null;

      if (target.document) {
        if (dto.status) {
          // Compare-and-set in one statement: concurrent decisions cannot both apply,
          // and a repeated decision is rejected instead of notifying twice.
          const { count } = await tx.document.updateMany({
            where: {
              id: target.document.id,
              reviewStatus: { not: dto.status },
            },
            data: {
              reviewStatus: dto.status,
              reviewStatusUpdatedAt: new Date(),
            },
          });
          if (count === 0) {
            const still = await tx.document.findUnique({
              where: { id: target.document.id },
              select: { id: true },
            });
            if (!still) throw documentNotFound();
            throw new ConflictException(
              workspaceError(
                E.SUBMISSION_STATUS_UNCHANGED,
                `The submission is already ${STATUS_LABEL[dto.status]}`,
              ),
            );
          }
        }
        const latest = await tx.documentVersion.findFirst({
          where: { documentId: target.document.id },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        documentVersion = latest?.version ?? null;
      }

      const created = await tx.feedback.create({
        data: {
          projectId: project.id,
          documentId: target.document?.id ?? null,
          documentVersion,
          taskId: target.task?.id ?? null,
          givenById: user.id,
          receivedById:
            target.document?.uploadedById ?? target.task?.assignedToId ?? null,
          comment: content.comment,
          category: content.category ?? FeedbackCategory.GENERAL,
          status: dto.status ?? null,
        },
        select: { id: true },
      });

      await this.notifications.notify(
        await this.access.getTeamStudentIds(project.teamId, tx),
        feedbackNotification('created', {
          feedbackId: created.id,
          projectId: project.id,
          documentId: target.document?.id ?? null,
          documentTitle: target.document?.title ?? null,
          taskId: target.task?.id ?? null,
          taskTitle: target.task?.title ?? null,
          status: dto.status ?? null,
        }),
        tx,
      );
      return created.id;
    });

    return this.toView(await this.loadOrThrow(id), user);
  }

  /** Records a review decision on a document (stored as feedback, visible in history). */
  async updateSubmissionStatus(
    user: AuthUser,
    documentId: string,
    dto: UpdateSubmissionStatusDto,
  ): Promise<FeedbackViewDto> {
    return this.create(user, {
      documentId,
      status: dto.status,
      comment: dto.comment,
    });
  }

  async update(
    user: AuthUser,
    feedbackId: string,
    dto: UpdateFeedbackDto,
  ): Promise<FeedbackViewDto> {
    const current = await this.loadOrThrow(feedbackId);
    if (current.givenById !== user.id) {
      throw new ForbiddenException(
        workspaceError(
          E.FEEDBACK_NOT_OWNER,
          'You can only edit your own feedback',
        ),
      );
    }
    if (!current.projectId) throw feedbackNotFound(); // project was deleted
    const project = await this.access.assertSupervisorOfProject(
      user,
      current.projectId,
    );

    const patch = normalizeContent(dto);
    const nextComment =
      dto.comment !== undefined ? patch.comment : current.comment;
    if (!nextComment && !current.status) {
      throw new BadRequestException(
        workspaceError(
          E.FEEDBACK_EMPTY,
          'Feedback must keep a comment or a status',
        ),
      );
    }
    const commentChanged =
      dto.comment !== undefined && nextComment !== current.comment;

    await this.prisma.$transaction(async (tx) => {
      await tx.feedback.update({
        where: { id: feedbackId },
        data: {
          ...(dto.comment !== undefined && { comment: nextComment }),
          ...(dto.category !== undefined && { category: dto.category }),
        },
      });
      if (commentChanged) {
        await this.notifications.notify(
          await this.access.getTeamStudentIds(project.teamId, tx),
          feedbackNotification('updated', {
            feedbackId,
            projectId: project.id,
            documentId: current.documentId,
            documentTitle: current.document?.title ?? null,
            taskId: current.taskId,
            taskTitle: current.task?.title ?? null,
            status: current.status,
          }),
          tx,
        );
      }
    });

    return this.toView(await this.loadOrThrow(feedbackId), user);
  }

  // ==========================================================
  // Reads (students of the project, or its supervisor)
  // ==========================================================

  async findMany(
    user: AuthUser,
    query: FeedbackQueryDto,
  ): Promise<FeedbackPageDto> {
    const where: Prisma.FeedbackWhereInput = {};

    if (query.documentId) {
      const doc = await this.prisma.document.findUnique({
        where: { id: query.documentId },
        select: { projectId: true },
      });
      if (!doc) throw documentNotFound();
      await this.access.assertCanViewProject(user, doc.projectId);
      if (query.projectId && query.projectId !== doc.projectId) {
        throw new BadRequestException(
          workspaceError(
            E.DOCUMENT_PROJECT_MISMATCH,
            'The document belongs to a different project',
          ),
        );
      }
      where.documentId = query.documentId;
    } else if (query.taskId) {
      const task = await this.prisma.task.findUnique({
        where: { id: query.taskId },
        select: { projectId: true },
      });
      if (!task) throw taskNotFound();
      await this.access.assertCanViewProject(user, task.projectId);
      if (query.projectId && query.projectId !== task.projectId) {
        throw new BadRequestException(
          workspaceError(
            E.TASK_PROJECT_MISMATCH,
            'The task belongs to a different project',
          ),
        );
      }
      where.taskId = query.taskId;
    } else if (query.projectId) {
      await this.access.assertCanViewProject(user, query.projectId);
      where.projectId = query.projectId;
    } else {
      where.projectId = { in: await this.access.getReadableProjectIds(user) };
    }
    if (query.status) where.status = query.status;

    const { page, limit, skip, take } = toPageArgs(query);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.feedback.count({ where }),
      this.prisma.feedback.findMany({
        where,
        select: FEEDBACK_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
      }),
    ]);
    return {
      items: rows.map((r) => this.toView(r, user)),
      meta: toPageMeta(page, limit, total),
    };
  }

  async findOne(user: AuthUser, feedbackId: string): Promise<FeedbackViewDto> {
    const row = await this.loadOrThrow(feedbackId);
    if (!row.projectId) throw feedbackNotFound();
    await this.access.assertCanViewProject(user, row.projectId);
    return this.toView(row, user);
  }

  // ==========================================================
  // Internals
  // ==========================================================

  private async resolveTarget(
    projectId?: string,
    documentId?: string,
    taskId?: string,
  ) {
    if (documentId && taskId) {
      throw new BadRequestException(
        workspaceError(
          E.FEEDBACK_TARGET_REQUIRED,
          'Feedback is on a document OR a task, not both',
        ),
      );
    }
    if (taskId) {
      const task = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { id: true, title: true, projectId: true, assignedToId: true },
      });
      if (!task) throw taskNotFound();
      if (projectId && projectId !== task.projectId) {
        throw new BadRequestException(
          workspaceError(
            E.TASK_PROJECT_MISMATCH,
            'The task belongs to a different project',
          ),
        );
      }
      return { projectId: task.projectId, document: null, task };
    }
    if (!documentId) {
      if (!projectId) {
        throw new BadRequestException(
          workspaceError(
            E.FEEDBACK_TARGET_REQUIRED,
            'Send projectId, documentId or taskId',
          ),
        );
      }
      return { projectId, document: null, task: null };
    }
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, title: true, projectId: true, uploadedById: true },
    });
    if (!document) throw documentNotFound();
    if (projectId && projectId !== document.projectId) {
      throw new BadRequestException(
        workspaceError(
          E.DOCUMENT_PROJECT_MISMATCH,
          'The document belongs to a different project',
        ),
      );
    }
    return { projectId: document.projectId, document, task: null };
  }

  private async loadOrThrow(
    feedbackId: string,
    db: Db = this.prisma,
  ): Promise<FeedbackRow> {
    const row = await db.feedback.findUnique({
      where: { id: feedbackId },
      select: FEEDBACK_SELECT,
    });
    if (!row) throw feedbackNotFound();
    return row;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private toView(row: FeedbackRow, _viewer: AuthUser): FeedbackViewDto {
    return {
      id: row.id,
      projectId: row.projectId,
      documentId: row.documentId,
      documentVersion: row.documentVersion,
      document: row.document,
      taskId: row.taskId,
      task: row.task,
      supervisorId: row.givenById,
      supervisor: row.givenBy,
      comment: row.comment,
      category: row.category,
      status: row.status,
      edited: row.updatedAt.getTime() > row.createdAt.getTime(),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

// ---------------------------------------------------------------------------

function normalizeContent(dto: UpdateFeedbackDto) {
  return {
    comment: dto.comment === undefined ? null : dto.comment || null,
    category: dto.category,
  };
}

function feedbackNotification(
  kind: 'created' | 'updated',
  ctx: {
    feedbackId: string;
    projectId: string;
    documentId: string | null;
    documentTitle: string | null;
    taskId: string | null;
    taskTitle: string | null;
    status: SubmissionStatus | null;
  },
) {
  const on = ctx.documentTitle
    ? `"${ctx.documentTitle}"`
    : ctx.taskTitle
      ? `the task "${ctx.taskTitle}"`
      : 'your project';
  let title: string;
  let message: string;
  if (kind === 'created' && ctx.status) {
    title = 'Submission status updated';
    message = `Your supervisor marked ${on} as ${STATUS_LABEL[ctx.status]}.`;
  } else if (kind === 'created') {
    title = 'New feedback';
    message = `Your supervisor left feedback on ${on}.`;
  } else {
    title = 'Feedback updated';
    message = `Your supervisor updated feedback on ${on}.`;
  }

  const isDecision = kind === 'created' && !!ctx.status;
  return {
    type: isDecision
      ? NotificationType.SUBMISSION_STATUS_CHANGED
      : NotificationType.FEEDBACK_RECEIVED,
    title,
    message,
    // P11: one notification per feedback item; edits are separate events
    ...(kind === 'created' && { dedupeKey: `feedback:${ctx.feedbackId}` }),
    // Supervisor feedback, comments and review decisions always reach the students
    // by e-mail too (outbox; account e-mail address)
    email: true,
    data: {
      kind:
        ctx.status && kind === 'created'
          ? 'submission_status'
          : `feedback_${kind}`,
      feedbackId: ctx.feedbackId,
      projectId: ctx.projectId,
      documentId: ctx.documentId,
      documentTitle: ctx.documentTitle,
      taskId: ctx.taskId,
      taskTitle: ctx.taskTitle,
      itemTitle: ctx.documentTitle ?? ctx.taskTitle ?? null,
      status: ctx.status,
    },
  };
}

function feedbackNotFound() {
  return new NotFoundException(
    workspaceError(E.FEEDBACK_NOT_FOUND, 'Feedback not found'),
  );
}

function taskNotFound() {
  return new NotFoundException(
    workspaceError(E.TASK_NOT_FOUND, 'Task not found'),
  );
}

function documentNotFound() {
  return new NotFoundException(
    workspaceError(E.DOCUMENT_NOT_FOUND, 'Document not found'),
  );
}
