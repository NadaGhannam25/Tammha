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
import {
  canChangeTaskStatus,
  TASK_STATUS_TRANSITIONS,
} from '@common/status/status-catalog';
import { toPageArgs, toPageMeta } from '@common/dtos/pagination.dto';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import {
  DeadlineQueryDto,
  TaskQueryDto,
  TaskSortField,
  UpcomingQueryDto,
} from './dto/task-query.dto';
import { TaskPageDto, TaskViewDto } from './dto/task-response.dto';
import { NotificationsService } from '@modules/notifications/notifications.service';
import { displayName } from '@modules/users/account.service';
import { assertUniversityIdentity } from '@common/identity/university-identity';

type Db = PrismaService | Prisma.TransactionClient;

/** Statuses that still need work. Overdue/upcoming only consider these. */
export const OPEN_TASK_STATUSES: TaskStatus[] = [
  TaskStatus.TODO,
  TaskStatus.IN_PROGRESS,
  TaskStatus.IN_REVIEW,
  TaskStatus.BLOCKED,
];

const CLOSED_TASK_STATUSES: TaskStatus[] = [
  TaskStatus.COMPLETED,
  TaskStatus.CANCELLED,
];

/** Only the columns and relation fields a task response needs (no N+1, no passwords). */
const TASK_SELECT = {
  id: true,
  title: true,
  description: true,
  projectId: true,
  milestoneId: true,
  assignedToId: true,
  status: true,
  priority: true,
  dueDate: true,
  completedAt: true,
  source: true,
  estimatedDays: true,
  createdAt: true,
  updatedAt: true,
  assignedTo: { select: PUBLIC_USER_SELECT },
  createdBy: { select: PUBLIC_USER_SELECT },
  milestone: { select: { id: true, title: true } },
} satisfies Prisma.TaskSelect;

type TaskRow = Prisma.TaskGetPayload<{ select: typeof TASK_SELECT }>;

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly notifications: NotificationsService,
  ) {}

  // ==========================================================
  // Writes (P16): the team LEADER creates, edits, assigns and deletes tasks;
  // a MEMBER may only change the status of a task assigned to them.
  // Supervisors have read-only access.
  // ==========================================================

  async create(user: AuthUser, dto: CreateTaskDto): Promise<TaskViewDto> {
    const project = await this.access.assertLeaderOfProject(
      user,
      dto.projectId,
    );

    if (dto.assignedStudentId) {
      await this.assertAssignable(dto.assignedStudentId, project.teamId);
    }
    if (dto.milestoneId) {
      await this.assertMilestoneOfProject(dto.milestoneId, project.id);
    }

    const status = dto.status ?? TaskStatus.TODO;
    const row = await this.prisma.task.create({
      data: {
        projectId: project.id,
        title: dto.title,
        description: dto.description || null,
        assignedToId: dto.assignedStudentId ?? null,
        milestoneId: dto.milestoneId ?? null,
        status,
        priority: dto.priority,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        completedAt: status === TaskStatus.COMPLETED ? new Date() : null,
        createdById: user.id,
      },
      select: TASK_SELECT,
    });
    if (row.assignedToId) await this.notifyAssigned(user, row, false);
    return this.toView(row);
  }

  async update(
    user: AuthUser,
    taskId: string,
    dto: UpdateTaskDto,
  ): Promise<TaskViewDto> {
    const current = await this.getTaskOrThrow(taskId);
    const project = await this.access.assertStudentOfProject(
      user,
      current.projectId,
    );
    const membership = await this.access.findMembershipInTeam(
      user.id,
      project.teamId,
    );
    if (membership?.role !== TeamRole.LEADER) {
      return this.updateOwnStatus(user, current, dto);
    }
    // the leader manages tasks only with a university identity
    assertUniversityIdentity(user);

    const data: Prisma.TaskUncheckedUpdateInput = {};
    if (typeof dto.title === 'string') data.title = dto.title;
    if (dto.description !== undefined)
      data.description = dto.description || null;
    if (dto.priority) data.priority = dto.priority;
    if (dto.dueDate !== undefined)
      data.dueDate = dto.dueDate ? new Date(dto.dueDate) : null;

    if (dto.assignedStudentId !== undefined) {
      if (dto.assignedStudentId) {
        await this.assertAssignable(dto.assignedStudentId, project.teamId);
      }
      data.assignedToId = dto.assignedStudentId;
    }

    if (dto.milestoneId !== undefined) {
      if (dto.milestoneId) {
        await this.assertMilestoneOfProject(dto.milestoneId, project.id);
      }
      data.milestoneId = dto.milestoneId;
    }

    if (dto.status && dto.status !== current.status) {
      assertTaskTransition(current.status, dto.status, true);
      data.status = dto.status;
      // completedAt follows the status: set on completion, cleared when reopened.
      if (dto.status === TaskStatus.COMPLETED) data.completedAt = new Date();
      else if (current.status === TaskStatus.COMPLETED) data.completedAt = null;
    }

    const row = await this.prisma.task.update({
      where: { id: taskId },
      data,
      select: TASK_SELECT,
    });
    if (row.assignedToId !== current.assignedToId) {
      if (row.assignedToId) {
        await this.notifyAssigned(user, row, !!current.assignedToId);
      }
      // the previous assignee learns the task moved away from them
      if (current.assignedToId) {
        await this.notifyAssignee(
          user,
          current.assignedToId,
          row,
          'unassigned',
        );
      }
    } else if (row.assignedToId) {
      const changes = describeChanges(current, row);
      if (changes.length > 0) {
        await this.notifyAssignee(
          user,
          row.assignedToId,
          row,
          'changed',
          changes,
        );
      }
    }
    return this.toView(row);
  }

  /**
   * MEMBER path: only { status } of a task assigned to them (TODO, IN_PROGRESS,
   * IN_REVIEW, COMPLETED, BLOCKED…). Ownership, deadlines and details stay with the leader.
   */
  private async updateOwnStatus(
    user: AuthUser,
    current: {
      id: string;
      projectId: string;
      status: TaskStatus;
      assignedToId: string | null;
    },
    dto: UpdateTaskDto,
  ): Promise<TaskViewDto> {
    const fields = Object.entries(dto)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k);
    if (fields.some((f) => f !== 'status') || !dto.status) {
      throw new ForbiddenException(
        workspaceError(
          E.TASK_STATUS_ONLY,
          'Team members can only update the status of their own tasks. Ask the team leader for other changes.',
        ),
      );
    }
    if (current.assignedToId !== user.id) {
      throw new ForbiddenException(
        workspaceError(
          E.TASK_NOT_ASSIGNED_TO_YOU,
          'You can only update the status of tasks assigned to you',
        ),
      );
    }
    const data: Prisma.TaskUncheckedUpdateInput = {};
    if (dto.status !== current.status) {
      assertTaskTransition(current.status, dto.status, false);
      data.status = dto.status;
      if (dto.status === TaskStatus.COMPLETED) data.completedAt = new Date();
      else if (current.status === TaskStatus.COMPLETED) data.completedAt = null;
    }
    const row = await this.prisma.task.update({
      where: { id: current.id },
      data,
      select: TASK_SELECT,
    });
    if (
      dto.status === TaskStatus.COMPLETED &&
      current.status !== TaskStatus.COMPLETED
    ) {
      await this.notifyLeaderCompleted(user, row);
    }
    return this.toView(row);
  }

  async remove(user: AuthUser, taskId: string) {
    const current = await this.getTaskOrThrow(taskId);
    await this.access.assertLeaderOfProject(user, current.projectId);
    await this.prisma.task.delete({ where: { id: taskId } });
    if (current.assignedToId) {
      await this.notifyAssignee(user, current.assignedToId, current, 'deleted');
    }
    return { message: 'Task deleted' };
  }

  // ==========================================================
  // Reads (students of the project, or its supervisor)
  // ==========================================================

  async findOne(user: AuthUser, taskId: string): Promise<TaskViewDto> {
    const current = await this.getTaskOrThrow(taskId);
    await this.access.assertCanViewProject(user, current.projectId);
    const row = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: TASK_SELECT,
    });
    return this.toView(row!);
  }

  /** Filtered, paginated list across the projects the user may read. */
  async findMany(user: AuthUser, query: TaskQueryDto): Promise<TaskPageDto> {
    const projectIds = await this.resolveProjectScope(user, query.projectId);
    const where: Prisma.TaskWhereInput = {
      projectId: { in: projectIds },
      ...this.assigneeFilter(user, query.assignedStudentId),
    };

    if (query.status?.length) where.status = { in: query.status };
    if (query.priority?.length) where.priority = { in: query.priority };
    if (query.milestoneId) {
      where.milestoneId =
        query.milestoneId === 'none' ? null : query.milestoneId;
    }
    if (query.search) {
      where.title = { contains: query.search.trim(), mode: 'insensitive' };
    }

    if (query.noDueDate) {
      where.dueDate = null;
    } else if (query.dueFrom || query.dueTo) {
      const from = query.dueFrom ? new Date(query.dueFrom) : undefined;
      const to = query.dueTo ? new Date(query.dueTo) : undefined;
      if (from && to && to < from) {
        throw new BadRequestException(
          workspaceError(
            E.INVALID_DATE_RANGE,
            'dueTo must not be before dueFrom',
          ),
        );
      }
      where.dueDate = { ...(from && { gte: from }), ...(to && { lte: to }) };
    }

    return this.page(
      where,
      query,
      query.sortBy ?? 'dueDate',
      query.sortOrder ?? 'asc',
    );
  }

  /** Open tasks whose deadline has passed (most overdue first). */
  async findOverdue(
    user: AuthUser,
    query: DeadlineQueryDto,
  ): Promise<TaskPageDto> {
    const projectIds = await this.resolveProjectScope(user, query.projectId);
    return this.page(
      {
        projectId: { in: projectIds },
        status: { in: OPEN_TASK_STATUSES },
        dueDate: { lt: new Date() },
        ...this.assigneeFilter(user, query.assignedStudentId),
      },
      query,
      'dueDate',
      'asc',
    );
  }

  /** Open tasks due within the next `days` days (default 7), soonest first. */
  async findUpcoming(
    user: AuthUser,
    query: UpcomingQueryDto,
  ): Promise<TaskPageDto> {
    const projectIds = await this.resolveProjectScope(user, query.projectId);
    const now = new Date();
    const until = new Date(
      now.getTime() + (query.days ?? 7) * 24 * 60 * 60 * 1000,
    );
    return this.page(
      {
        projectId: { in: projectIds },
        status: { in: OPEN_TASK_STATUSES },
        dueDate: { gte: now, lte: until },
        ...this.assigneeFilter(user, query.assignedStudentId),
      },
      query,
      'dueDate',
      'asc',
    );
  }

  /** Views of tasks by id, in the given order (used by Apply AI Task Suggestions). */
  async viewsByIds(
    ids: string[],
    db: Db = this.prisma,
  ): Promise<TaskViewDto[]> {
    if (ids.length === 0) return [];
    const rows = await db.task.findMany({
      where: { id: { in: ids } },
      select: TASK_SELECT,
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids
      .map((id) => byId.get(id))
      .filter((r): r is TaskRow => !!r)
      .map((r) => this.toView(r));
  }

  /** Assignee must be a STUDENT member of the project's team (400 ASSIGNEE_NOT_IN_TEAM). */
  assertAssignableTo(userId: string, teamId: string) {
    return this.assertAssignable(userId, teamId);
  }

  // ==========================================================
  // Internals
  // ==========================================================

  /** P16: TASK_ASSIGNED to the (new) assignee; never to the leader assigning themselves. */
  async notifyAssigned(
    actor: AuthUser,
    task: {
      id: string;
      title: string;
      projectId: string;
      assignedToId: string | null;
      dueDate: Date | null;
    },
    reassigned: boolean,
    db: Db = this.prisma,
  ) {
    if (!task.assignedToId || task.assignedToId === actor.id) return;
    await this.notifications.notify(
      [task.assignedToId],
      {
        type: NotificationType.TASK_ASSIGNED,
        title: reassigned
          ? 'Task reassigned to you'
          : 'New task assigned to you',
        message: `${displayName(actor.firstName, actor.lastName)} assigned you "${task.title}"${task.dueDate ? ` (due ${task.dueDate.toISOString().slice(0, 10)})` : ''}.`,
        data: {
          kind: reassigned ? 'task_reassigned' : 'task_assigned',
          actorName: displayName(actor.firstName, actor.lastName),
          taskTitle: task.title,
          taskId: task.id,
          projectId: task.projectId,
          dueDate: task.dueDate?.toISOString() ?? null,
        },
        // one notification per (task, assignee): repeated reassignments to the same person stay quiet
        dedupeKey: `task-assigned:${task.id}:${task.assignedToId}`,
        email: true,
      },
      db,
    );
  }

  private async notifyLeaderCompleted(
    member: AuthUser,
    task: { id: string; title: string; projectId: string },
  ) {
    const project = await this.prisma.project.findUnique({
      where: { id: task.projectId },
      select: { teamId: true },
    });
    const leaderId = project
      ? await this.access.getTeamLeaderId(project.teamId)
      : null;
    if (!leaderId || leaderId === member.id) return;
    await this.notifications.notify([leaderId], {
      type: NotificationType.TASK_UPDATED,
      title: 'Task completed',
      message: `${displayName(member.firstName, member.lastName)} completed "${task.title}".`,
      data: {
        kind: 'task_completed',
        actorName: displayName(member.firstName, member.lastName),
        taskTitle: task.title,
        taskId: task.id,
        projectId: task.projectId,
      },
      dedupeKey: `task-completed:${task.id}`,
      email: true,
    });
  }

  /**
   * Important changes made by the leader to a task of someone else: details changed,
   * moved to another student, or deleted. In-app + e-mail; never to the actor.
   * Changes within the same minute share one notification (no e-mail bursts).
   */
  private async notifyAssignee(
    actor: AuthUser,
    assigneeId: string,
    task: { id: string; title: string; projectId: string },
    kind: 'changed' | 'unassigned' | 'deleted',
    changes: string[] = [],
  ) {
    if (assigneeId === actor.id) return;
    const who = displayName(actor.firstName, actor.lastName);
    const text = {
      changed: {
        title: 'Your task was updated',
        message: `${who} updated "${task.title}": ${changes.join(', ')}.`,
      },
      unassigned: {
        title: 'Task reassigned',
        message: `${who} reassigned "${task.title}" to another team member.`,
      },
      deleted: {
        title: 'Task removed',
        message: `${who} deleted "${task.title}", which was assigned to you.`,
      },
    }[kind];
    const minute = Math.floor(Date.now() / 60_000);
    await this.notifications.notify([assigneeId], {
      type: NotificationType.TASK_UPDATED,
      ...text,
      data: {
        kind: `task_${kind}`,
        actorName: who,
        taskTitle: task.title,
        taskId: task.id,
        projectId: task.projectId,
        ...(changes.length && { changes }),
      },
      dedupeKey: `task-${kind}:${task.id}:${assigneeId}:${minute}`,
      email: true,
    });
  }

  /**
   * Projects the query may cover. An explicit projectId must be readable
   * (403 otherwise); without one, all readable projects are used.
   */
  private async resolveProjectScope(
    user: AuthUser,
    projectId?: string,
  ): Promise<string[]> {
    if (projectId) {
      await this.access.assertCanViewProject(user, projectId);
      return [projectId];
    }
    return this.access.getReadableProjectIds(user);
  }

  private assigneeFilter(
    user: AuthUser,
    assignee?: string,
  ): Prisma.TaskWhereInput {
    if (!assignee) return {};
    if (assignee === 'none') return { assignedToId: null };
    if (assignee === 'me') {
      if (user.role !== UserRole.STUDENT) {
        throw new BadRequestException(
          'assignedStudentId=me is only available to students',
        );
      }
      return { assignedToId: user.id };
    }
    return { assignedToId: assignee };
  }

  /** One count + one page query in a single round trip. Stable order (id tiebreak). */
  private async page(
    where: Prisma.TaskWhereInput,
    pagination: { page?: number; limit?: number },
    sortBy: TaskSortField,
    sortOrder: 'asc' | 'desc',
  ): Promise<TaskPageDto> {
    const { page, limit, skip, take } = toPageArgs(pagination);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.task.count({ where }),
      this.prisma.task.findMany({
        where,
        select: TASK_SELECT,
        orderBy: [...taskOrderBy(sortBy, sortOrder), { id: 'asc' }],
        skip,
        take,
      }),
    ]);
    return {
      items: rows.map((r) => this.toView(r)),
      meta: toPageMeta(page, limit, total),
    };
  }

  private async getTaskOrThrow(taskId: string, db: Db = this.prisma) {
    const task = await db.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        projectId: true,
        status: true,
        assignedToId: true,
        title: true,
        dueDate: true,
        priority: true,
        milestoneId: true,
      },
    });
    if (!task) {
      throw new NotFoundException(
        workspaceError(E.TASK_NOT_FOUND, 'Task not found'),
      );
    }
    return task;
  }

  /** Assignee must be a STUDENT member of the project's team. */
  private async assertAssignable(userId: string, teamId: string) {
    if (!(await this.access.isStudentOfProjectTeam(userId, teamId))) {
      throw new BadRequestException(
        workspaceError(
          E.ASSIGNEE_NOT_IN_TEAM,
          'Tasks can only be assigned to students of this project team',
        ),
      );
    }
  }

  private async assertMilestoneOfProject(
    milestoneId: string,
    projectId: string,
  ) {
    const milestone = await this.prisma.milestone.findUnique({
      where: { id: milestoneId },
      select: { projectId: true },
    });
    if (!milestone) {
      throw new NotFoundException(
        workspaceError(E.MILESTONE_NOT_FOUND, 'Milestone not found'),
      );
    }
    if (milestone.projectId !== projectId) {
      throw new BadRequestException(
        workspaceError(
          E.MILESTONE_PROJECT_MISMATCH,
          'The milestone belongs to a different project',
        ),
      );
    }
  }

  private toView(row: TaskRow): TaskViewDto {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      projectId: row.projectId,
      status: row.status,
      priority: row.priority,
      dueDate: row.dueDate,
      completedAt: row.completedAt,
      isOverdue: isTaskOverdue(row.status, row.dueDate),
      assignedStudentId: row.assignedToId,
      assignedStudent: row.assignedTo,
      milestone: row.milestone,
      createdBy: row.createdBy,
      source: row.source,
      estimatedDays: row.estimatedDays,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

export function isTaskOverdue(
  status: TaskStatus,
  dueDate: Date | null,
  now: Date = new Date(),
): boolean {
  return !!dueDate && dueDate < now && !CLOSED_TASK_STATUSES.includes(status);
}

/**
 * ORDER BY for task lists. Tasks without a deadline always sort last.
 * priority: the PostgreSQL enum sorts in declaration order (LOW..CRITICAL), so
 * "asc" here means most important first (CRITICAL..LOW), then by deadline.
 */
export function taskOrderBy(
  sortBy: TaskSortField,
  sortOrder: 'asc' | 'desc',
): Prisma.TaskOrderByWithRelationInput[] {
  switch (sortBy) {
    case 'dueDate':
      return [{ dueDate: { sort: sortOrder, nulls: 'last' } }];
    case 'priority':
      return [
        { priority: sortOrder === 'asc' ? 'desc' : 'asc' },
        { dueDate: { sort: 'asc', nulls: 'last' } },
      ];
    default:
      return [{ [sortBy]: sortOrder }];
  }
}

/** Human-readable list of the changes an assignee cares about. */
export function describeChanges(
  before: {
    title: string;
    status: TaskStatus;
    dueDate: Date | null;
    priority: string;
    milestoneId: string | null;
  },
  after: {
    title: string;
    status: TaskStatus;
    dueDate: Date | null;
    priority: string;
    milestoneId: string | null;
  },
): string[] {
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : 'none');
  const out: string[] = [];
  if (before.title !== after.title) out.push(`title is now "${after.title}"`);
  if (day(before.dueDate) !== day(after.dueDate)) {
    out.push(`due date ${day(after.dueDate)}`);
  }
  if (before.status !== after.status) out.push(`status ${after.status}`);
  if (before.priority !== after.priority)
    out.push(`priority ${after.priority}`);
  if (before.milestoneId !== after.milestoneId) out.push('milestone changed');
  return out;
}

/** 409 INVALID_STATUS_TRANSITION, with the allowed next statuses. */
function assertTaskTransition(
  from: TaskStatus,
  to: TaskStatus,
  isLeader: boolean,
) {
  if (canChangeTaskStatus(from, to, isLeader)) return;
  throw new ConflictException({
    ...workspaceError(
      E.INVALID_STATUS_TRANSITION,
      !TASK_STATUS_TRANSITIONS[from].includes(to)
        ? `A task cannot go from ${from} to ${to}`
        : 'Only the team leader can cancel a task or restore a cancelled one',
    ),
    details: {
      from,
      to,
      allowed: TASK_STATUS_TRANSITIONS[from].filter((s) =>
        canChangeTaskStatus(from, s, isLeader),
      ),
    },
  });
}
