import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MilestoneStatus, NotificationType, TaskStatus } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import {
  NotificationSettings,
  readNotificationSettings,
} from '../notifications.config';
import {
  NotificationInput,
  NotificationsService,
} from '../notifications.service';

const OPEN_TASK_STATUSES: TaskStatus[] = [
  TaskStatus.TODO,
  TaskStatus.IN_PROGRESS,
  TaskStatus.IN_REVIEW,
  TaskStatus.BLOCKED,
];
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Upper bound per run and kind; the next run continues where this one stopped. */
const MAX_TASKS_PER_RUN = 500;
/**
 * Task deadline reminder: 24 hours before the due date, the same for every task (no
 * per-task reminder times). The job runs every REMINDER_INTERVAL_MINUTES, so a task
 * is reminded once when it enters its last 24 hours.
 */
export const TASK_REMINDER_HOURS_BEFORE = 24;
/** Milestones (project stages) are announced earlier than tasks. */
export const MILESTONE_REMINDER_DAYS_BEFORE = 3;
const OPEN_MILESTONE_STATUSES: MilestoneStatus[] = [
  MilestoneStatus.PENDING,
  MilestoneStatus.IN_PROGRESS,
  MilestoneStatus.OVERDUE,
];

export interface ReminderRunResult {
  dueSoonTasks: number;
  overdueTasks: number;
  dueSoonMilestones: number;
  notificationsCreated: number;
}

/**
 * Deadline reminders (run by the scheduler, safe to run any number of times):
 *  - TASK_DUE_SOON  unfinished task due within the next 24 hours (fixed)
 *  - TASK_OVERDUE   open task past its due date (first reported within OVERDUE_LOOKBACK_DAYS)
 *  - MILESTONE_DUE  open milestone (project stage) due within 3 days, to every student of the team
 * All of them are also e-mailed (outbox) when e-mail delivery is enabled.
 *
 * Recipient: the assignee when they are still in the team, otherwise every student of the team.
 * No duplicates: dedupeKey = kind + task id + due date. Moving the due date gives a new key,
 * so the student is reminded again for the new deadline; anything else is skipped by the
 * unique (userId, dedupeKey) index, even with several app instances running.
 */
@Injectable()
export class TaskRemindersService {
  private readonly logger = new Logger('TaskReminders');
  readonly settings: NotificationSettings;
  private running: Promise<ReminderRunResult> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    config: ConfigService,
  ) {
    this.settings = readNotificationSettings({
      OVERDUE_LOOKBACK_DAYS: config.get('OVERDUE_LOOKBACK_DAYS'),
    }).settings;
  }

  /** Concurrent calls in one process share the same run. */
  run(now = new Date()): Promise<ReminderRunResult> {
    if (!this.running) {
      this.running = this.runOnce(now).finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async runOnce(now: Date): Promise<ReminderRunResult> {
    const select = {
      id: true,
      title: true,
      dueDate: true,
      projectId: true,
      assignedToId: true,
      project: { select: { teamId: true } },
    } as const;

    const [dueSoon, overdue, milestones] = await Promise.all([
      this.prisma.task.findMany({
        where: {
          status: { in: OPEN_TASK_STATUSES },
          dueDate: {
            gt: now,
            lte: new Date(now.getTime() + TASK_REMINDER_HOURS_BEFORE * HOUR_MS),
          },
        },
        select,
        orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
        take: MAX_TASKS_PER_RUN,
      }),
      this.prisma.task.findMany({
        where: {
          status: { in: OPEN_TASK_STATUSES },
          dueDate: {
            lt: now,
            gte: new Date(
              now.getTime() - this.settings.overdueLookbackDays * DAY_MS,
            ),
          },
        },
        select,
        orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
        take: MAX_TASKS_PER_RUN,
      }),
      this.prisma.milestone.findMany({
        where: {
          status: { in: OPEN_MILESTONE_STATUSES },
          dueDate: {
            gt: now,
            lte: new Date(
              now.getTime() + MILESTONE_REMINDER_DAYS_BEFORE * DAY_MS,
            ),
          },
        },
        select: {
          id: true,
          title: true,
          dueDate: true,
          projectId: true,
          project: { select: { teamId: true } },
        },
        orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
        take: MAX_TASKS_PER_RUN,
      }),
    ]);

    // Students of every involved team in ONE query.
    const teamIds = [
      ...new Set(
        [...dueSoon, ...overdue, ...milestones].map((t) => t.project.teamId),
      ),
    ];
    const members = teamIds.length
      ? await this.prisma.teamMember.findMany({
          where: { teamId: { in: teamIds } },
          select: { teamId: true, userId: true },
        })
      : [];
    const studentsByTeam = new Map<string, string[]>();
    for (const m of members) {
      studentsByTeam.set(m.teamId, [
        ...(studentsByTeam.get(m.teamId) ?? []),
        m.userId,
      ]);
    }

    type Task = (typeof dueSoon)[number];
    const recipients = (t: Task) => {
      const team = studentsByTeam.get(t.project.teamId) ?? [];
      return t.assignedToId && team.includes(t.assignedToId)
        ? [t.assignedToId]
        : team;
    };

    const items: { userId: string; input: NotificationInput }[] = [];
    for (const t of dueSoon) {
      const hours = Math.max(
        1,
        Math.round((t.dueDate!.getTime() - now.getTime()) / HOUR_MS),
      );
      const input: NotificationInput = {
        type: NotificationType.TASK_DUE_SOON,
        title: 'Task due soon',
        message: `"${t.title}" is due in about ${hours} hour${hours === 1 ? '' : 's'}.`,
        data: {
          kind: 'task_due_soon',
          taskTitle: t.title,
          taskId: t.id,
          projectId: t.projectId,
          dueDate: t.dueDate!.toISOString(),
        },
        dedupeKey: `task-due-soon:${t.id}:${t.dueDate!.toISOString()}`,
        email: true,
      };
      for (const userId of recipients(t)) items.push({ userId, input });
    }
    for (const t of overdue) {
      const days = Math.floor((now.getTime() - t.dueDate!.getTime()) / DAY_MS);
      const input: NotificationInput = {
        type: NotificationType.TASK_OVERDUE,
        title: 'Task overdue',
        message:
          days < 1
            ? `"${t.title}" is overdue (it was due today).`
            : `"${t.title}" is overdue by ${days} day${days === 1 ? '' : 's'}.`,
        data: {
          kind: 'task_overdue',
          taskTitle: t.title,
          taskId: t.id,
          projectId: t.projectId,
          dueDate: t.dueDate!.toISOString(),
        },
        dedupeKey: `task-overdue:${t.id}:${t.dueDate!.toISOString()}`,
        email: true,
      };
      for (const userId of recipients(t)) items.push({ userId, input });
    }

    for (const m of milestones) {
      const days = Math.max(
        1,
        Math.ceil((m.dueDate.getTime() - now.getTime()) / DAY_MS),
      );
      const input: NotificationInput = {
        type: NotificationType.MILESTONE_DUE,
        title: 'Milestone due soon',
        message: `The project stage "${m.title}" is due in ${days} day${days === 1 ? '' : 's'}.`,
        data: {
          kind: 'milestone_due_soon',
          milestoneTitle: m.title,
          milestoneId: m.id,
          projectId: m.projectId,
          dueDate: m.dueDate.toISOString(),
        },
        dedupeKey: `milestone-due-soon:${m.id}:${m.dueDate.toISOString()}`,
        email: true,
      };
      for (const userId of studentsByTeam.get(m.project.teamId) ?? []) {
        items.push({ userId, input });
      }
    }

    const created = await this.prisma.$transaction((tx) =>
      this.notifications.notifyEach(items, tx),
    );
    if (created.length > 0) {
      this.logger.log(
        `reminders: ${created.length} new (due soon: ${dueSoon.length} tasks, overdue: ${overdue.length} tasks)`,
      );
    }
    return {
      dueSoonTasks: dueSoon.length,
      overdueTasks: overdue.length,
      dueSoonMilestones: milestones.length,
      notificationsCreated: created.length,
    };
  }
}
