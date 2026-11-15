import { Injectable } from '@nestjs/common';
import {
  MeetingStatus,
  MilestoneStatus,
  Prisma,
  ProjectSetupStep,
  SubmissionStatus,
  TaskStatus,
  TeamInvitationStatus,
  TeamRole,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuthUser } from '@common/types/auth-user.type';
import { PUBLIC_USER_SELECT } from '@common/workspace/user-select';
import { WorkspaceAccessService } from '@common/workspace/workspace-access.service';
import { FeedbackService } from '@modules/feedback/feedback.service';
import { hasUniversityIdentity } from '@common/identity/university-identity';
import { loadEffectiveHandbook } from '@modules/ai-support/handbook/handbook-state';
import {
  AWAITING_REVIEW_STATUSES,
  CLOSED_MILESTONE_STATUSES,
  NEEDS_CHANGES_STATUSES,
  OPEN_TASK_STATUSES,
  ProjectStats,
  requiredDocumentStatuses,
} from './progress/progress.rules';
import {
  ProjectMetrics,
  ProjectMetricsService,
} from './progress/project-metrics.service';
import { DashboardQueryDto } from './dto/dashboard-query.dto';
import {
  DashboardHandbookDto,
  DashboardTaskItemDto,
  DeadlineDto,
  MilestoneSummaryDto,
  ProjectProgressResponseDto,
  StudentDashboardDto,
  SubmissionSummaryDto,
  SupervisedProjectDto,
  SupervisorDashboardDto,
  TaskSummaryDto,
} from './dto/dashboard-response.dto';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 14;
const DEFAULT_LIMIT = 5;
const MAX_MILESTONES = 50;

const DASHBOARD_TASK_SELECT = {
  id: true,
  title: true,
  status: true,
  priority: true,
  dueDate: true,
  assignedToId: true,
} satisfies Prisma.TaskSelect;
const UPCOMING_MEETING_STATUSES: MeetingStatus[] = [
  MeetingStatus.SCHEDULED,
  MeetingStatus.ONGOING,
];

const MEETING_SELECT = {
  id: true,
  projectId: true,
  title: true,
  scheduledAt: true,
  duration: true,
  location: true,
  meetingUrl: true,
  status: true,
} satisfies Prisma.MeetingSelect;

const DOCUMENT_SUMMARY_SELECT = {
  id: true,
  projectId: true,
  title: true,
  category: true,
  reviewStatus: true,
  reviewStatusUpdatedAt: true,
  createdAt: true,
  updatedAt: true,
  uploadedBy: { select: PUBLIC_USER_SELECT },
  _count: { select: { versions: true } },
} satisfies Prisma.DocumentSelect;

/**
 * Dashboards. Every section is loaded with a fixed number of queries
 * (batched with `in` filters and groupBy), never one query per project/row.
 * Access: students see their own project, supervisors the projects they supervise.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly metrics: ProjectMetricsService,
    private readonly feedback: FeedbackService,
  ) {}

  // ==========================================================
  // Project progress / readiness (students of the project, its supervisor)
  // ==========================================================

  async getProjectProgress(
    user: AuthUser,
    projectId: string,
  ): Promise<ProjectProgressResponseDto> {
    await this.access.assertCanViewProject(user, projectId);
    const metrics = (await this.metrics.loadMetrics([projectId])).get(
      projectId,
    )!;
    return {
      projectId,
      calculatedAt: new Date(),
      progress: metrics.progress,
      readiness: metrics.readiness,
    };
  }

  // ==========================================================
  // Student dashboard
  // ==========================================================

  async getStudentDashboard(
    user: AuthUser,
    query: DashboardQueryDto,
  ): Promise<StudentDashboardDto> {
    const now = new Date();
    const days = query.days ?? DEFAULT_DAYS;
    const limit = query.limit ?? DEFAULT_LIMIT;
    const horizon = new Date(now.getTime() + days * DAY_MS);

    // A student can have several projects: show the requested one (must be theirs),
    // else the most recently joined; `projects` lists all of them for switching.
    const memberships = await this.access.findStudentMemberships(user.id);
    const myProjects = await this.prisma.project.findMany({
      where: { teamId: { in: memberships.map((m) => m.teamId) } },
      select: {
        id: true,
        name: true,
        status: true,
        setupStep: true,
        teamId: true,
      },
    });
    const roleByTeam = new Map(memberships.map((m) => [m.teamId, m.role]));
    const rank = new Map(memberships.map((m, i) => [m.teamId, i]));
    myProjects.sort((a, b) => rank.get(a.teamId)! - rank.get(b.teamId)!);
    const projects = myProjects.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      setupStep: p.setupStep,
      teamRole: roleByTeam.get(p.teamId)!,
    }));
    let selected: (typeof myProjects)[number] | null = myProjects[0] ?? null;
    if (query.projectId) {
      selected = myProjects.find((p) => p.id === query.projectId) ?? null;
      if (!selected)
        await this.access.assertCanViewProject(user, query.projectId); // 404/403
    }
    const membership = selected
      ? memberships.find((m) => m.teamId === selected!.teamId)!
      : null;
    const project = membership
      ? await this.prisma.project.findUnique({
          where: { teamId: membership.teamId },
          select: {
            id: true,
            name: true,
            description: true,
            status: true,
            startDate: true,
            endDate: true,
            teamId: true,
            overview: true,
            objectives: true,
            category: true,
            origin: true,
            expectedCompletionDate: true,
            setupStep: true,
            setupCompletedAt: true,
            team: { select: { name: true } },
          },
        })
      : null;

    const [unreadNotifications, pendingTeamInvitations] = await Promise.all([
      this.unreadCount(user.id),
      this.prisma.teamInvitation.count({
        where: { inviteeId: user.id, status: TeamInvitationStatus.PENDING },
      }),
    ]);
    const viewer = {
      teamRole: membership?.role ?? null,
      isLeader: membership?.role === TeamRole.LEADER,
      // NO_PROJECT + false: ask for a student number or university e-mail before "Create project"
      profileComplete: hasUniversityIdentity(user),
    };
    if (!project) {
      return {
        state: 'NO_PROJECT',
        hasProject: false,
        viewer,
        setup: null,
        myTasks: null,
        overdueTasks: [],
        handbook: null,
        pendingTeamInvitations,
        projects,
        project: null,
        completionPercent: 0,
        tasks: null,
        milestones: null,
        upcomingDeadlines: [],
        latestDocuments: [],
        latestFeedback: [],
        upcomingMeetings: [],
        unreadNotifications,
        submissions: null,
        progress: null,
        readiness: null,
        generatedAt: now,
      };
    }

    const projectId = project.id;
    const [
      members,
      supervisors,
      metricsMap,
      milestones,
      milestoneTaskCounts,
      upcomingTasks,
      latestDocuments,
      latestFeedback,
      upcomingMeetings,
      myOpenTasks,
      overdueTasks,
      handbook,
    ] = await Promise.all([
      this.prisma.teamMember.findMany({
        where: { teamId: project.teamId },
        select: { role: true, user: { select: PUBLIC_USER_SELECT } },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.projectMember.findMany({
        where: { projectId, user: { role: UserRole.SUPERVISOR } },
        select: { user: { select: PUBLIC_USER_SELECT } },
        take: 1,
      }),
      this.metrics.loadMetrics([projectId]),
      this.prisma.milestone.findMany({
        where: { projectId },
        select: { id: true, title: true, dueDate: true, status: true },
        orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
        take: MAX_MILESTONES,
      }),
      this.prisma.task.groupBy({
        by: ['milestoneId', 'status'],
        where: { projectId, milestoneId: { not: null } },
        _count: { _all: true },
        orderBy: { milestoneId: 'asc' },
      }),
      this.prisma.task.findMany({
        where: {
          projectId,
          status: { in: OPEN_TASK_STATUSES },
          dueDate: { gte: now, lte: horizon },
        },
        select: {
          id: true,
          title: true,
          dueDate: true,
          status: true,
          priority: true,
          assignedTo: { select: PUBLIC_USER_SELECT },
        },
        orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
        take: limit,
      }),
      this.prisma.document.findMany({
        where: { projectId },
        select: DOCUMENT_SUMMARY_SELECT,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        take: limit,
      }),
      this.feedback.findMany(user, { projectId, page: 1, limit }),
      this.upcomingMeetings([projectId], now, horizon, limit),
      this.prisma.task.findMany({
        where: {
          projectId,
          assignedToId: user.id,
          status: { in: OPEN_TASK_STATUSES },
        },
        select: DASHBOARD_TASK_SELECT,
        orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
        take: 100,
      }),
      this.prisma.task.findMany({
        where: {
          projectId,
          status: { in: OPEN_TASK_STATUSES },
          dueDate: { lt: now },
        },
        select: DASHBOARD_TASK_SELECT,
        orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
        take: limit,
      }),
      this.handbookState(projectId),
    ]);

    const metrics = metricsMap.get(projectId)!;
    const milestoneSummary = this.milestoneSummary(
      metrics.stats,
      milestones,
      milestoneTaskCounts,
      now,
    );

    const deadlines: DeadlineDto[] = [
      ...upcomingTasks.map((t) => ({
        type: 'TASK' as const,
        id: t.id,
        title: t.title,
        dueDate: t.dueDate!,
        status: t.status,
        daysLeft: daysBetween(now, t.dueDate!),
        priority: t.priority,
        assignedTo: t.assignedTo,
      })),
      ...milestones
        .filter(
          (m) =>
            !CLOSED_MILESTONE_STATUSES.includes(m.status) &&
            m.dueDate >= now &&
            m.dueDate <= horizon,
        )
        .map((m) => ({
          type: 'MILESTONE' as const,
          id: m.id,
          title: m.title,
          dueDate: m.dueDate,
          status: m.status,
          daysLeft: daysBetween(now, m.dueDate),
        })),
    ]
      .sort(
        (a, b) =>
          a.dueDate.getTime() - b.dueDate.getTime() ||
          a.type.localeCompare(b.type) ||
          a.id.localeCompare(b.id),
      )
      .slice(0, limit);

    const myOverdue = myOpenTasks.filter((t) => t.dueDate && t.dueDate < now);
    const myUpcoming = myOpenTasks.filter(
      (t) => !t.dueDate || t.dueDate >= now,
    );
    const setupCompleted = project.setupStep === ProjectSetupStep.COMPLETED;
    const isEmpty = metrics.stats.tasks.total === 0 && milestones.length === 0;
    const leader = members.find((m) => m.role === TeamRole.LEADER);

    return {
      state: !setupCompleted
        ? 'SETUP_IN_PROGRESS'
        : isEmpty
          ? 'EMPTY_PROJECT'
          : 'ACTIVE',
      hasProject: true,
      viewer,
      projects,
      setup: {
        step: project.setupStep,
        completed: setupCompleted,
        completedAt: project.setupCompletedAt,
      },
      myTasks: {
        open: myOpenTasks.length,
        overdue: myOverdue.length,
        items: [...myOverdue, ...myUpcoming]
          .slice(0, limit)
          .map((t) => toTaskItem(t, now)),
      },
      overdueTasks: overdueTasks.map((t) => toTaskItem(t, now)),
      handbook,
      pendingTeamInvitations,
      project: {
        id: project.id,
        name: project.name,
        description: project.description,
        status: project.status,
        startDate: project.startDate,
        endDate: project.endDate,
        teamId: project.teamId,
        teamName: project.team.name,
        members,
        supervisor: supervisors[0]?.user ?? null,
        overview: project.overview,
        objectives: project.objectives ?? [],
        category: project.category,
        origin: project.origin,
        expectedCompletionDate: project.expectedCompletionDate,
        leader: leader?.user ?? null,
      },
      completionPercent: metrics.progress.percent,
      tasks: this.taskSummary(metrics.stats),
      milestones: milestoneSummary,
      upcomingDeadlines: deadlines,
      latestDocuments: latestDocuments.map(toDocumentSummary),
      latestFeedback: latestFeedback.items,
      upcomingMeetings,
      unreadNotifications,
      submissions: this.submissionSummary(metrics.stats),
      progress: metrics.progress,
      readiness: metrics.readiness,
      generatedAt: now,
    };
  }

  // ==========================================================
  // Supervisor dashboard
  // ==========================================================

  async getSupervisorDashboard(
    user: AuthUser,
    query: DashboardQueryDto,
  ): Promise<SupervisorDashboardDto> {
    const now = new Date();
    const days = query.days ?? DEFAULT_DAYS;
    const limit = query.limit ?? DEFAULT_LIMIT;
    const horizon = new Date(now.getTime() + days * DAY_MS);

    const projectIds = await this.access.getReadableProjectIds(user);
    const unreadNotifications = await this.unreadCount(user.id);
    if (projectIds.length === 0) {
      return emptySupervisorDashboard(unreadNotifications, now);
    }

    const [
      projects,
      metricsMap,
      overdueTasks,
      latestVersions,
      awaitingDocs,
      upcomingMeetings,
    ] = await Promise.all([
      this.prisma.project.findMany({
        where: { id: { in: projectIds } },
        select: {
          id: true,
          name: true,
          status: true,
          endDate: true,
          teamId: true,
          team: { select: { name: true } },
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
      this.metrics.loadMetrics(projectIds),
      this.prisma.task.findMany({
        where: {
          projectId: { in: projectIds },
          status: { in: OPEN_TASK_STATUSES },
          dueDate: { lt: now },
        },
        select: {
          id: true,
          projectId: true,
          title: true,
          dueDate: true,
          status: true,
          priority: true,
          assignedTo: { select: PUBLIC_USER_SELECT },
        },
        orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
        take: limit,
      }),
      this.prisma.documentVersion.findMany({
        where: { document: { projectId: { in: projectIds } } },
        select: {
          version: true,
          createdAt: true,
          documentId: true,
          document: {
            select: {
              title: true,
              projectId: true,
              category: true,
              reviewStatus: true,
            },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: limit,
      }),
      this.prisma.document.findMany({
        where: {
          projectId: { in: projectIds },
          reviewStatus: { in: AWAITING_REVIEW_STATUSES },
        },
        select: {
          id: true,
          projectId: true,
          title: true,
          category: true,
          reviewStatus: true,
          updatedAt: true,
        },
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take: limit,
      }),
      this.upcomingMeetings(projectIds, now, horizon, limit),
    ]);

    // Team sizes for all projects: one grouped query.
    const memberCounts = await this.prisma.teamMember.groupBy({
      by: ['teamId'],
      where: { teamId: { in: projects.map((p) => p.teamId) } },
      _count: { _all: true },
      orderBy: { teamId: 'asc' },
    });
    const membersByTeam = new Map(
      memberCounts.map((r) => [
        r.teamId,
        (r._count as { _all?: number } | undefined)?._all ?? 0,
      ]),
    );
    const names = new Map(projects.map((p) => [p.id, p.name]));

    const rows: SupervisedProjectDto[] = projects.map((p) =>
      this.supervisedProject(
        p,
        metricsMap.get(p.id)!,
        membersByTeam.get(p.teamId) ?? 0,
      ),
    );

    const sum = (pick: (r: SupervisedProjectDto) => number) =>
      rows.reduce((total, r) => total + pick(r), 0);
    const overdueProjects = rows.filter((r) => r.hasOverdue);

    return {
      summary: {
        totalProjects: rows.length,
        projectsWithOverdue: overdueProjects.length,
        overdueTasks: sum((r) => r.tasks.overdue),
        overdueMilestones: sum((r) => r.milestones.overdue),
        awaitingReview: sum((r) => r.awaitingReview),
        needsChanges: sum((r) => r.needsChanges),
        averageProgress:
          rows.length === 0
            ? 0
            : Math.round(sum((r) => r.progressPercent) / rows.length),
        readyProjects: rows.filter((r) => r.readinessLevel === 'READY').length,
        unreadNotifications,
      },
      projects: rows,
      overdue: {
        projects: overdueProjects.map((r) => ({
          id: r.id,
          name: r.name,
          overdueTasks: r.tasks.overdue,
          overdueMilestones: r.milestones.overdue,
        })),
        tasks: overdueTasks.map((t) => ({
          id: t.id,
          projectId: t.projectId,
          projectName: names.get(t.projectId) ?? '',
          title: t.title,
          dueDate: t.dueDate!,
          status: t.status,
          priority: t.priority,
          daysOverdue: daysBetween(t.dueDate!, now),
          assignedTo: t.assignedTo,
        })),
        totalOverdueTasks: sum((r) => r.tasks.overdue),
      },
      latestSubmissions: latestVersions.map((v) => ({
        documentId: v.documentId,
        projectId: v.document.projectId,
        projectName: names.get(v.document.projectId) ?? '',
        title: v.document.title,
        category: v.document.category,
        version: v.version,
        submittedAt: v.createdAt,
        reviewStatus: v.document.reviewStatus,
      })),
      awaitingReview: {
        total: sum((r) => r.awaitingReview),
        items: awaitingDocs.map((d) => ({
          documentId: d.id,
          projectId: d.projectId,
          projectName: names.get(d.projectId) ?? '',
          title: d.title,
          category: d.category,
          reviewStatus: d.reviewStatus,
          waitingSince: d.updatedAt,
          daysWaiting: daysBetween(d.updatedAt, now),
        })),
      },
      upcomingMeetings,
      generatedAt: now,
    };
  }

  // ==========================================================
  // Helpers
  // ==========================================================

  /** Same states as GET /projects/:projectId/handbook (metadata only). */
  private async handbookState(
    projectId: string,
  ): Promise<DashboardHandbookDto> {
    const h = await loadEffectiveHandbook(this.prisma, projectId);
    return {
      state: h.state,
      source: h.source,
      title: h.title,
      version: h.version,
    };
  }

  private unreadCount(userId: string) {
    return this.prisma.notification.count({
      where: { userId, isRead: false },
    });
  }

  private upcomingMeetings(
    projectIds: string[],
    now: Date,
    horizon: Date,
    limit: number,
  ) {
    return this.prisma.meeting.findMany({
      where: {
        projectId: { in: projectIds },
        status: { in: UPCOMING_MEETING_STATUSES },
        scheduledAt: { gte: now, lte: horizon },
      },
      select: MEETING_SELECT,
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
  }

  private taskSummary(stats: ProjectStats): TaskSummaryDto {
    const t = stats.tasks;
    return {
      total: t.total,
      completed: t.completed,
      pending: t.open,
      overdue: t.overdue,
      cancelled: t.cancelled,
      completionPercent:
        t.total === 0 ? 0 : Math.round((t.completed / t.total) * 100),
      byStatus: t.byStatus,
    };
  }

  private milestoneSummary(
    stats: ProjectStats,
    milestones: {
      id: string;
      title: string;
      dueDate: Date;
      status: MilestoneStatus;
    }[],
    taskCounts: {
      milestoneId: string | null;
      status: string;
      _count?: unknown;
    }[],
    now: Date,
  ): MilestoneSummaryDto {
    const perMilestone = new Map<string, { total: number; done: number }>();
    for (const row of taskCounts) {
      if (!row.milestoneId || row.status === 'CANCELLED') continue;
      const n = (row._count as { _all?: number } | undefined)?._all ?? 0;
      const p = perMilestone.get(row.milestoneId) ?? { total: 0, done: 0 };
      p.total += n;
      if (row.status === 'COMPLETED') p.done += n;
      perMilestone.set(row.milestoneId, p);
    }
    return {
      total: stats.milestones.total,
      completed: stats.milestones.completed,
      pending: stats.milestones.open,
      overdue: stats.milestones.overdue,
      items: milestones.map((m) => {
        const p = perMilestone.get(m.id) ?? { total: 0, done: 0 };
        return {
          id: m.id,
          title: m.title,
          dueDate: m.dueDate,
          status: m.status,
          isOverdue:
            m.dueDate < now && !CLOSED_MILESTONE_STATUSES.includes(m.status),
          totalTasks: p.total,
          completedTasks: p.done,
          percent: p.total === 0 ? 0 : Math.round((p.done / p.total) * 100),
        };
      }),
    };
  }

  private submissionSummary(stats: ProjectStats): SubmissionSummaryDto {
    const by = stats.documents.byStatus;
    const add = (list: SubmissionStatus[]) =>
      list.reduce((sum, s) => sum + by[s], 0);
    return {
      total: stats.documents.total,
      awaitingReview: add(AWAITING_REVIEW_STATUSES),
      needsChanges: add(NEEDS_CHANGES_STATUSES),
      approved: by.APPROVED,
      byStatus: by,
      requiredDocuments: requiredDocumentStatuses(
        stats,
        this.metrics.requiredDocuments,
      ),
    };
  }

  private supervisedProject(
    p: {
      id: string;
      name: string;
      status: SupervisedProjectDto['status'];
      endDate: Date | null;
      teamId: string;
      team: { name: string };
    },
    m: ProjectMetrics,
    memberCount: number,
  ): SupervisedProjectDto {
    const { tasks, milestones, documents } = m.stats;
    const add = (list: SubmissionStatus[]) =>
      list.reduce((sum, s) => sum + documents.byStatus[s], 0);
    return {
      id: p.id,
      name: p.name,
      status: p.status,
      endDate: p.endDate,
      teamId: p.teamId,
      teamName: p.team.name,
      memberCount,
      progressPercent: m.progress.percent,
      readinessScore: m.readiness.score,
      readinessLevel: m.readiness.level,
      tasks: {
        total: tasks.total,
        completed: tasks.completed,
        pending: tasks.open,
        overdue: tasks.overdue,
      },
      milestones: {
        total: milestones.total,
        completed: milestones.completed,
        pending: milestones.open,
        overdue: milestones.overdue,
      },
      awaitingReview: add(AWAITING_REVIEW_STATUSES),
      needsChanges: add(NEEDS_CHANGES_STATUSES),
      hasOverdue: tasks.overdue + milestones.overdue > 0,
    };
  }
}

// ---------------------------------------------------------------------------

/** Whole days from `from` to `to` (0 = same day or less than 24h). */
function toTaskItem(
  t: Prisma.TaskGetPayload<{ select: typeof DASHBOARD_TASK_SELECT }>,
  now: Date,
): DashboardTaskItemDto {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    dueDate: t.dueDate,
    daysLeft: t.dueDate
      ? Math.floor((t.dueDate.getTime() - now.getTime()) / DAY_MS)
      : null,
    isOverdue:
      !!t.dueDate &&
      t.dueDate < now &&
      t.status !== TaskStatus.COMPLETED &&
      t.status !== TaskStatus.CANCELLED,
    assignedStudentId: t.assignedToId,
  };
}

function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));
}

function toDocumentSummary(
  d: Prisma.DocumentGetPayload<{ select: typeof DOCUMENT_SUMMARY_SELECT }>,
) {
  return {
    id: d.id,
    projectId: d.projectId,
    title: d.title,
    category: d.category,
    reviewStatus: d.reviewStatus,
    reviewStatusUpdatedAt: d.reviewStatusUpdatedAt,
    versions: d._count.versions,
    uploadedBy: d.uploadedBy,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

function emptySupervisorDashboard(
  unreadNotifications: number,
  now: Date,
): SupervisorDashboardDto {
  return {
    summary: {
      totalProjects: 0,
      projectsWithOverdue: 0,
      overdueTasks: 0,
      overdueMilestones: 0,
      awaitingReview: 0,
      needsChanges: 0,
      averageProgress: 0,
      readyProjects: 0,
      unreadNotifications,
    },
    projects: [],
    overdue: { projects: [], tasks: [], totalOverdueTasks: 0 },
    latestSubmissions: [],
    awaitingReview: { total: 0, items: [] },
    upcomingMeetings: [],
    generatedAt: now,
  };
}
