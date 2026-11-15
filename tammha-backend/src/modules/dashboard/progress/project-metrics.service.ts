import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentCategory, TaskStatus } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import {
  calculateProgress,
  calculateReadiness,
  CLOSED_MILESTONE_STATUSES,
  emptyStats,
  OPEN_TASK_STATUSES,
  parseRequiredDocumentCategories,
  ProgressResult,
  ProjectStats,
  ReadinessResult,
} from './progress.rules';

export interface ProjectMetrics {
  stats: ProjectStats;
  progress: ProgressResult;
  readiness: ReadinessResult;
}

/**
 * Loads the counts behind Progress/Readiness for MANY projects at once:
 * 5 grouped queries in one read transaction, whatever the number of projects
 * (no per-project or per-row queries).
 */
@Injectable()
export class ProjectMetricsService {
  readonly requiredDocuments: DocumentCategory[];

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    // Validated at startup (env.validation.ts); falls back to the defaults.
    this.requiredDocuments = parseRequiredDocumentCategories(
      config.get<string>('REQUIRED_DOCUMENT_CATEGORIES'),
    ).categories;
  }

  async loadStats(projectIds: string[]): Promise<Map<string, ProjectStats>> {
    const result = new Map<string, ProjectStats>();
    if (projectIds.length === 0) return result;
    for (const id of projectIds) result.set(id, emptyStats());

    const now = new Date();
    const inProjects = { projectId: { in: projectIds } };
    const [tasksByStatus, overdueTasks, msByStatus, overdueMs, docs] =
      await this.prisma.$transaction([
        this.prisma.task.groupBy({
          by: ['projectId', 'status'],
          where: inProjects,
          _count: { _all: true },
          orderBy: { projectId: 'asc' },
        }),
        this.prisma.task.groupBy({
          by: ['projectId'],
          where: {
            ...inProjects,
            status: { in: OPEN_TASK_STATUSES },
            dueDate: { lt: now },
          },
          _count: { _all: true },
          orderBy: { projectId: 'asc' },
        }),
        this.prisma.milestone.groupBy({
          by: ['projectId', 'status'],
          where: inProjects,
          _count: { _all: true },
          orderBy: { projectId: 'asc' },
        }),
        this.prisma.milestone.groupBy({
          by: ['projectId'],
          where: {
            ...inProjects,
            status: { notIn: CLOSED_MILESTONE_STATUSES },
            dueDate: { lt: now },
          },
          _count: { _all: true },
          orderBy: { projectId: 'asc' },
        }),
        this.prisma.document.groupBy({
          by: ['projectId', 'category', 'reviewStatus'],
          where: inProjects,
          _count: { _all: true },
          orderBy: { projectId: 'asc' },
        }),
      ]);

    const count = (row: { _count?: unknown }) =>
      (row._count as { _all?: number } | undefined)?._all ?? 0;

    for (const row of tasksByStatus) {
      const s = result.get(row.projectId);
      if (!s) continue;
      const n = count(row);
      s.tasks.byStatus[row.status] += n;
      if (row.status === TaskStatus.CANCELLED) {
        s.tasks.cancelled += n;
        continue;
      }
      s.tasks.total += n;
      if (row.status === TaskStatus.COMPLETED) s.tasks.completed += n;
      else s.tasks.open += n;
    }
    for (const row of overdueTasks) {
      const s = result.get(row.projectId);
      if (s) s.tasks.overdue = count(row);
    }
    for (const row of msByStatus) {
      const s = result.get(row.projectId);
      if (!s) continue;
      const n = count(row);
      if (row.status === 'CANCELLED') {
        s.milestones.cancelled += n;
        continue;
      }
      s.milestones.total += n;
      if (row.status === 'COMPLETED') s.milestones.completed += n;
      else s.milestones.open += n;
    }
    for (const row of overdueMs) {
      const s = result.get(row.projectId);
      if (s) s.milestones.overdue = count(row);
    }
    for (const row of docs) {
      const s = result.get(row.projectId);
      if (!s) continue;
      const n = count(row);
      s.documents.total += n;
      s.documents.byStatus[row.reviewStatus] += n;
      const cat = (s.documents.byCategory[row.category] ??= {});
      cat[row.reviewStatus] = (cat[row.reviewStatus] ?? 0) + n;
    }
    return result;
  }

  async loadMetrics(
    projectIds: string[],
  ): Promise<Map<string, ProjectMetrics>> {
    const stats = await this.loadStats(projectIds);
    const out = new Map<string, ProjectMetrics>();
    for (const [id, s] of stats) out.set(id, this.evaluate(s));
    return out;
  }

  evaluate(stats: ProjectStats): ProjectMetrics {
    return {
      stats,
      progress: calculateProgress(stats, this.requiredDocuments),
      readiness: calculateReadiness(stats, this.requiredDocuments),
    };
  }
}
