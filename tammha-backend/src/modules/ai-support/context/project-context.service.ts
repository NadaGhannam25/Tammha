import { Injectable, NotFoundException } from '@nestjs/common';
import { Project, TaskStatus, UserRole } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuthUser } from '@common/types/auth-user.type';
import { ProjectMetricsService } from '@modules/dashboard/progress/project-metrics.service';
import {
  CLOSED_MILESTONE_STATUSES,
  OPEN_TASK_STATUSES,
} from '@modules/dashboard/progress/progress.rules';

const MAX_OPEN_TASKS = 25;
const MAX_MILESTONES = 15;
const MAX_DOCUMENTS = 15;
const MAX_FEEDBACK = 3;

/**
 * The ONLY project data sent to the AI provider. Deliberately minimal:
 * no names, emails or user ids, no scores or rubrics, no file contents or links.
 */
export interface ProjectContext {
  requesterRole: 'student' | 'supervisor';
  project: {
    name: string;
    description: string | null;
    status: string;
    startDate: string | null;
    endDate: string | null;
    /** P16 project details (set by the leader during setup or later) */
    overview: string | null;
    objectives: string[];
    category: string | null;
    origin: string | null;
    expectedCompletionDate: string | null;
  };
  /**
   * P16: anonymised team structure ("Leader", "Member 2", ...) with open-task load,
   * so the AI can balance suggestions. No names, emails or ids.
   */
  team: {
    studentCount: number;
    hasSupervisor: boolean;
    members: { label: string; role: 'LEADER' | 'MEMBER'; openTasks: number }[];
    unassignedOpenTasks: number;
  };
  /** P09 rule-based values, shown to the model read-only */
  progress: {
    percent: number;
    readinessScore: number;
    readinessLevel: string;
    missing: string[];
  };
  tasks: {
    total: number;
    completed: number;
    open: number;
    overdue: number;
    openItems: {
      title: string;
      status: TaskStatus;
      priority: string;
      dueDate: string | null;
      overdue: boolean;
      milestone: string | null;
      /** anonymised label from team.members, or null when unassigned */
      assignee: string | null;
    }[];
  };
  milestones: {
    title: string;
    status: string;
    dueDate: string;
    overdue: boolean;
    totalTasks: number;
    completedTasks: number;
    focus: boolean;
  }[];
  documents: { title: string; category: string; reviewStatus: string }[];
  requiredDocuments: { category: string; status: string }[];
  /** Latest supervisor comments (only for features that ask for them; never scores) */
  feedback: { date: string; status: string | null; comment: string }[];
}

const day = (d: Date | null | undefined) =>
  d ? d.toISOString().slice(0, 10) : null;
const clip = (s: string | null | undefined, max: number) =>
  !s ? null : s.length <= max ? s : `${s.slice(0, max - 1)}…`;

@Injectable()
export class ProjectContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: ProjectMetricsService,
  ) {}

  /** Throws 404 AI_MILESTONE_NOT_FOUND when the milestone is not in this project. */
  async assertMilestoneInProject(projectId: string, milestoneId: string) {
    const m = await this.prisma.milestone.findFirst({
      where: { id: milestoneId, projectId },
      select: { id: true },
    });
    if (!m) {
      throw new NotFoundException({
        code: 'AI_MILESTONE_NOT_FOUND',
        message: 'Milestone not found in this project',
      });
    }
  }

  async build(
    user: AuthUser,
    project: Project,
    options: { includeFeedback: boolean; focusMilestoneId?: string | null },
  ): Promise<ProjectContext> {
    const now = new Date();
    const focus = options.focusMilestoneId ?? null;
    const [
      members,
      supervisors,
      metricsMap,
      openTasks,
      milestones,
      milestoneTasks,
      documents,
      feedback,
    ] = await Promise.all([
      this.prisma.teamMember.findMany({
        where: { teamId: project.teamId },
        select: { userId: true, role: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.projectMember.count({
        where: { projectId: project.id, user: { role: UserRole.SUPERVISOR } },
      }),
      this.metrics.loadMetrics([project.id]),
      this.prisma.task.findMany({
        where: {
          projectId: project.id,
          status: { in: OPEN_TASK_STATUSES },
          ...(focus && { milestoneId: focus }),
        },
        select: {
          title: true,
          status: true,
          priority: true,
          dueDate: true,
          assignedToId: true,
          milestone: { select: { title: true } },
        },
        orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
        take: MAX_OPEN_TASKS,
      }),
      this.prisma.milestone.findMany({
        where: { projectId: project.id },
        select: { id: true, title: true, status: true, dueDate: true },
        orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
        take: MAX_MILESTONES,
      }),
      this.prisma.task.groupBy({
        by: ['milestoneId', 'status'],
        where: { projectId: project.id, milestoneId: { not: null } },
        _count: { _all: true },
        orderBy: { milestoneId: 'asc' },
      }),
      this.prisma.document.findMany({
        where: { projectId: project.id },
        select: { title: true, category: true, reviewStatus: true },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        take: MAX_DOCUMENTS,
      }),
      options.includeFeedback
        ? this.prisma.feedback.findMany({
            where: { projectId: project.id, comment: { not: null } },
            select: { comment: true, status: true, createdAt: true },
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            take: MAX_FEEDBACK,
          })
        : Promise.resolve([]),
    ]);

    const m = metricsMap.get(project.id)!;
    // leader first, then members in join order
    const ordered = [...members].sort(
      (a, b) => Number(b.role === 'LEADER') - Number(a.role === 'LEADER'),
    );
    const labels = new Map(
      ordered.map((tm, i) => [
        tm.userId,
        tm.role === 'LEADER' ? 'Leader' : `Member ${i + 1}`,
      ]),
    );
    const openByUser = await this.prisma.task.groupBy({
      by: ['assignedToId'],
      where: { projectId: project.id, status: { in: OPEN_TASK_STATUSES } },
      _count: { _all: true },
      orderBy: { assignedToId: 'asc' },
    });
    const openCount = new Map<string | null, number>(
      openByUser.map((r) => [
        r.assignedToId,
        (r._count as { _all?: number } | undefined)?._all ?? 0,
      ]),
    );
    const perMilestone = new Map<string, { total: number; done: number }>();
    for (const row of milestoneTasks) {
      if (!row.milestoneId || row.status === TaskStatus.CANCELLED) continue;
      const n = (row._count as { _all?: number } | undefined)?._all ?? 0;
      const p = perMilestone.get(row.milestoneId) ?? { total: 0, done: 0 };
      p.total += n;
      if (row.status === TaskStatus.COMPLETED) p.done += n;
      perMilestone.set(row.milestoneId, p);
    }

    return {
      requesterRole:
        user.role === UserRole.SUPERVISOR ? 'supervisor' : 'student',
      project: {
        name: clip(project.name, 150)!,
        description: clip(project.description, 1000),
        status: project.status,
        startDate: day(project.startDate),
        endDate: day(project.endDate),
        overview: clip(project.overview, 1500),
        objectives: (project.objectives ?? [])
          .slice(0, 10)
          .map((o) => clip(o, 300)!),
        category: project.category ?? null,
        origin: project.origin ?? null,
        expectedCompletionDate: day(project.expectedCompletionDate),
      },
      team: {
        studentCount: members.length,
        hasSupervisor: supervisors > 0,
        members: ordered.map((tm) => ({
          label: labels.get(tm.userId)!,
          role: tm.role,
          openTasks: openCount.get(tm.userId) ?? 0,
        })),
        unassignedOpenTasks: openCount.get(null) ?? 0,
      },
      progress: {
        percent: m.progress.percent,
        readinessScore: m.readiness.score,
        readinessLevel: m.readiness.level,
        missing: m.readiness.missing,
      },
      tasks: {
        total: m.stats.tasks.total,
        completed: m.stats.tasks.completed,
        open: m.stats.tasks.open,
        overdue: m.stats.tasks.overdue,
        openItems: openTasks.map((t) => ({
          title: clip(t.title, 120)!,
          status: t.status,
          priority: t.priority,
          dueDate: day(t.dueDate),
          overdue: !!t.dueDate && t.dueDate < now,
          milestone: clip(t.milestone?.title, 120),
          assignee: t.assignedToId
            ? (labels.get(t.assignedToId) ?? 'Former member')
            : null,
        })),
      },
      milestones: milestones.map((ms) => {
        const p = perMilestone.get(ms.id) ?? { total: 0, done: 0 };
        return {
          title: clip(ms.title, 120)!,
          status: ms.status,
          dueDate: day(ms.dueDate)!,
          overdue:
            ms.dueDate < now && !CLOSED_MILESTONE_STATUSES.includes(ms.status),
          totalTasks: p.total,
          completedTasks: p.done,
          focus: ms.id === focus,
        };
      }),
      documents: documents.map((d) => ({
        title: clip(d.title, 120)!,
        category: d.category,
        reviewStatus: d.reviewStatus,
      })),
      requiredDocuments: m.readiness.requiredDocuments.map((r) => ({
        category: r.category,
        status: r.status,
      })),
      feedback: feedback.map((f) => ({
        date: day(f.createdAt)!,
        status: f.status,
        comment: clip(f.comment, 300)!,
      })),
    };
  }
}
