import { Injectable, NotFoundException } from '@nestjs/common';
import { Milestone, MilestoneStatus, Prisma, TaskStatus } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuthUser } from '@common/types/auth-user.type';
import { WorkspaceAccessService } from '@common/workspace/workspace-access.service';
import {
  WorkspaceErrorCode as E,
  workspaceError,
} from '@common/workspace/workspace-errors';
import { toPageArgs, toPageMeta } from '@common/dtos/pagination.dto';
import { OPEN_TASK_STATUSES } from '@modules/tasks/tasks.service';
import {
  CreateMilestoneDto,
  MilestonePageDto,
  MilestoneProgressDto,
  MilestoneQueryDto,
  MilestoneViewDto,
  SETTABLE_MILESTONE_STATUSES,
  UpdateMilestoneDto,
} from './dto/milestone.dto';

const CLOSED_MILESTONE_STATUSES: MilestoneStatus[] = [
  MilestoneStatus.COMPLETED,
  MilestoneStatus.CANCELLED,
];

@Injectable()
export class MilestonesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
  ) {}

  // ---------------- writes (P16: the team LEADER) ----------------

  async create(
    user: AuthUser,
    dto: CreateMilestoneDto,
  ): Promise<MilestoneViewDto> {
    const project = await this.access.assertLeaderOfProject(
      user,
      dto.projectId,
    );
    const milestone = await this.prisma.milestone.create({
      data: {
        projectId: project.id,
        title: dto.title,
        description: dto.description || null,
        dueDate: new Date(dto.dueDate),
        status: dto.status ?? MilestoneStatus.PENDING,
        sortOrder: dto.order ?? null,
        createdById: user.id,
      },
    });
    const current = await this.ensureCurrentStage(project.id);
    return this.toView(
      current?.id === milestone.id ? current : milestone,
      emptyProgress(),
    );
  }

  /**
   * The first stage is the project's current stage by default: when no stage of the
   * project has started (none IN_PROGRESS or COMPLETED), the first one in order
   * (position, then due date) becomes IN_PROGRESS. Nothing else changes, and stages are
   * never completed automatically. Returns the stage that was started, if any.
   */
  private async ensureCurrentStage(
    projectId: string,
  ): Promise<Milestone | null> {
    const started = await this.prisma.milestone.count({
      where: {
        projectId,
        status: {
          in: [MilestoneStatus.IN_PROGRESS, MilestoneStatus.COMPLETED],
        },
      },
    });
    if (started > 0) return null;
    const first = await this.prisma.milestone.findFirst({
      where: { projectId, status: MilestoneStatus.PENDING },
      orderBy: [
        { sortOrder: { sort: 'asc', nulls: 'last' } },
        { dueDate: 'asc' },
        { id: 'asc' },
      ],
    });
    if (!first) return null;
    return this.prisma.milestone.update({
      where: { id: first.id },
      data: { status: MilestoneStatus.IN_PROGRESS },
    });
  }

  async update(
    user: AuthUser,
    milestoneId: string,
    dto: UpdateMilestoneDto,
  ): Promise<MilestoneViewDto> {
    const current = await this.getOrThrow(milestoneId);
    await this.access.assertLeaderOfProject(user, current.projectId);

    const data: Prisma.MilestoneUpdateInput = {};
    if (dto.order !== undefined) data.sortOrder = dto.order;
    if (typeof dto.title === 'string') data.title = dto.title;
    if (dto.description !== undefined)
      data.description = dto.description || null;
    if (dto.dueDate) data.dueDate = new Date(dto.dueDate);
    if (dto.status) data.status = dto.status;

    const milestone = await this.prisma.milestone.update({
      where: { id: milestoneId },
      data,
    });
    const progress = await this.progressFor([milestoneId]);
    return this.toView(milestone, progress.get(milestoneId) ?? emptyProgress());
  }

  /** Deletes the milestone. Its tasks are kept and simply lose the milestone link. */
  async remove(user: AuthUser, milestoneId: string) {
    const current = await this.getOrThrow(milestoneId);
    await this.access.assertLeaderOfProject(user, current.projectId);
    await this.prisma.milestone.delete({ where: { id: milestoneId } });
    return {
      message: 'Milestone deleted. Its tasks were kept without a milestone.',
    };
  }

  // ---------------- reads (students of the project, or its supervisor) ----------------

  async findOne(
    user: AuthUser,
    milestoneId: string,
  ): Promise<MilestoneViewDto> {
    const milestone = await this.getOrThrow(milestoneId);
    await this.access.assertCanViewProject(user, milestone.projectId);
    const progress = await this.progressFor([milestoneId]);
    return this.toView(milestone, progress.get(milestoneId) ?? emptyProgress());
  }

  async findMany(
    user: AuthUser,
    query: MilestoneQueryDto,
  ): Promise<MilestonePageDto> {
    let projectIds: string[];
    if (query.projectId) {
      await this.access.assertCanViewProject(user, query.projectId);
      projectIds = [query.projectId];
    } else {
      projectIds = await this.access.getReadableProjectIds(user);
    }

    const where: Prisma.MilestoneWhereInput = { projectId: { in: projectIds } };
    if (query.status?.length) where.status = { in: query.status };
    if (query.overdue === true) {
      // Overdue = past due and still open (requested statuses minus closed ones).
      const open = (
        query.status?.length ? query.status : SETTABLE_MILESTONE_STATUSES
      ).filter((status) => !CLOSED_MILESTONE_STATUSES.includes(status));
      where.status = { in: open };
      where.dueDate = { lt: new Date() };
    }

    const { page, limit, skip, take } = toPageArgs(query);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.milestone.count({ where }),
      this.prisma.milestone.findMany({
        where,
        orderBy: [
          { sortOrder: { sort: 'asc', nulls: 'last' } },
          { dueDate: 'asc' },
          { id: 'asc' },
        ],
        skip,
        take,
      }),
    ]);

    const progress = await this.progressFor(rows.map((m) => m.id));
    return {
      items: rows.map((m) =>
        this.toView(m, progress.get(m.id) ?? emptyProgress()),
      ),
      meta: toPageMeta(page, limit, total),
    };
  }

  // ---------------- internals ----------------

  private async getOrThrow(milestoneId: string): Promise<Milestone> {
    const milestone = await this.prisma.milestone.findUnique({
      where: { id: milestoneId },
    });
    if (!milestone) {
      throw new NotFoundException(
        workspaceError(E.MILESTONE_NOT_FOUND, 'Milestone not found'),
      );
    }
    return milestone;
  }

  /**
   * Progress for many milestones with two aggregate queries in total
   * (no per-milestone queries): task counts by status, and overdue open tasks.
   */
  private async progressFor(
    milestoneIds: string[],
  ): Promise<Map<string, MilestoneProgressDto>> {
    const result = new Map<string, MilestoneProgressDto>();
    if (milestoneIds.length === 0) return result;
    for (const id of milestoneIds) result.set(id, emptyProgress());

    const [byStatus, overdue] = await Promise.all([
      this.prisma.task.groupBy({
        by: ['milestoneId', 'status'],
        where: { milestoneId: { in: milestoneIds } },
        _count: { _all: true },
      }),
      this.prisma.task.groupBy({
        by: ['milestoneId'],
        where: {
          milestoneId: { in: milestoneIds },
          status: { in: OPEN_TASK_STATUSES },
          dueDate: { lt: new Date() },
        },
        _count: { _all: true },
      }),
    ]);

    for (const row of byStatus) {
      const p = result.get(row.milestoneId!);
      if (!p) continue;
      const n = row._count._all;
      if (row.status === TaskStatus.CANCELLED) continue;
      p.totalTasks += n;
      if (row.status === TaskStatus.COMPLETED) p.completedTasks += n;
      else p.openTasks += n;
    }
    for (const row of overdue) {
      const p = result.get(row.milestoneId!);
      if (p) p.overdueTasks = row._count._all;
    }
    for (const p of result.values()) {
      p.percent =
        p.totalTasks === 0
          ? 0
          : Math.round((p.completedTasks / p.totalTasks) * 100);
    }
    return result;
  }

  private toView(
    m: Milestone,
    progress: MilestoneProgressDto,
  ): MilestoneViewDto {
    return {
      id: m.id,
      projectId: m.projectId,
      title: m.title,
      description: m.description,
      dueDate: m.dueDate,
      status: m.status,
      order: m.sortOrder ?? null,
      isOverdue:
        m.dueDate < new Date() && !CLOSED_MILESTONE_STATUSES.includes(m.status),
      progress,
      createdById: m.createdById,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
  }
}

function emptyProgress(): MilestoneProgressDto {
  return {
    totalTasks: 0,
    completedTasks: 0,
    openTasks: 0,
    overdueTasks: 0,
    percent: 0,
  };
}
