import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AISupportStatus,
  Prisma,
  Priority,
  TaskSource,
  TaskStatus,
} from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuthUser } from '@common/types/auth-user.type';
import { WorkspaceAccessService } from '@common/workspace/workspace-access.service';
import {
  WorkspaceErrorCode as E,
  workspaceError,
} from '@common/workspace/workspace-errors';
import { TasksService } from '@modules/tasks/tasks.service';
import type {
  Guidance,
  GuidanceTaskSuggestion,
} from '../guidance/guidance.schema';
import {
  ApplyAiTaskSuggestionsDto,
  ApplyAiTaskSuggestionsResultDto,
  SkippedSuggestionDto,
} from './apply-suggestions.dto';

type Db = PrismaService | Prisma.TransactionClient;

const err = (code: string, message: string) => ({ code, message });

/** "  Write  the Report " and "write the report" are the same task title. */
export const normalizeTitle = (title: string) =>
  title.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/** Idempotency key stored in tasks.sourceKey (unique). */
export const suggestionKey = (aiRequestId: string, suggestionId: string) =>
  `${aiRequestId}:${suggestionId}`;

/**
 * Apply AI Task Suggestions (P16) — the ONLY path from AI output to real data, and it is
 * an explicit action of the team LEADER on suggestions they selected (and may have edited).
 *
 * - The AI request must be the leader's own COMPLETED request for this project.
 * - Every value is validated server-side like a manual task (assignee in the team,
 *   milestone in the project, enums, lengths, dates); the AI text is only a default.
 * - Idempotent: tasks.sourceKey = "<aiRequestId>:<suggestionId>" is unique, so applying the
 *   same suggestion twice returns it under alreadyApplied instead of creating a duplicate.
 * - Suggestions whose title matches an existing open task are skipped (DUPLICATE_TITLE).
 * - Created tasks are normal tasks (source AI_SUGGESTION): members update their status,
 *   the leader edits/reassigns/deletes them, assignees are notified.
 */
@Injectable()
export class AiTaskSuggestionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly tasks: TasksService,
  ) {}

  async apply(
    user: AuthUser,
    projectId: string,
    dto: ApplyAiTaskSuggestionsDto,
  ): Promise<ApplyAiTaskSuggestionsResultDto> {
    const project = await this.access.assertLeaderOfProject(user, projectId);

    const request = await this.prisma.aISupport.findFirst({
      where: { id: dto.aiRequestId, projectId: project.id, userId: user.id },
      select: { id: true, status: true, result: true },
    });
    if (!request) {
      throw new NotFoundException(
        err('AI_REQUEST_NOT_FOUND', 'AI request not found in this project'),
      );
    }
    if (request.status !== AISupportStatus.COMPLETED) {
      throw new ConflictException(
        err(
          'AI_REQUEST_NOT_COMPLETED',
          'Only a completed AI answer can be applied',
        ),
      );
    }
    const suggestions = suggestionsOf(request.result);

    // validate the selection before any write
    const seen = new Set<string>();
    for (const item of dto.items) {
      if (seen.has(item.suggestionId)) {
        throw new BadRequestException(
          err(
            'AI_SUGGESTION_DUPLICATED',
            `Suggestion ${item.suggestionId} is selected more than once`,
          ),
        );
      }
      seen.add(item.suggestionId);
      if (!suggestions.has(item.suggestionId)) {
        throw new BadRequestException(
          err(
            'AI_SUGGESTION_NOT_FOUND',
            `Suggestion ${item.suggestionId} is not part of this AI answer`,
          ),
        );
      }
    }
    const milestones = await this.prisma.milestone.findMany({
      where: { projectId: project.id },
      select: { id: true, title: true },
    });
    const milestoneIds = new Set(milestones.map((m) => m.id));
    const milestoneByTitle = new Map(
      milestones.map((m) => [normalizeTitle(m.title), m.id]),
    );
    const assignees = [
      ...new Set(
        dto.items
          .map((i) => i.assignedStudentId)
          .filter((x): x is string => !!x),
      ),
    ];
    for (const id of assignees) {
      await this.tasks.assertAssignableTo(id, project.teamId);
    }

    const prepared = dto.items.map((item) => {
      const s = suggestions.get(item.suggestionId)!;
      if (item.milestoneId && !milestoneIds.has(item.milestoneId)) {
        throw new BadRequestException(
          workspaceError(
            E.MILESTONE_PROJECT_MISMATCH,
            'The milestone does not belong to this project',
          ),
        );
      }
      const title = (item.title ?? s.title).trim().slice(0, 200);
      if (title.length < 2) {
        throw new BadRequestException(
          err(
            'AI_SUGGESTION_INVALID',
            `Suggestion ${item.suggestionId} needs a title`,
          ),
        );
      }
      return {
        suggestionId: item.suggestionId,
        key: suggestionKey(request.id, item.suggestionId),
        title,
        description: (item.description ?? s.description ?? '').trim() || null,
        priority: item.priority ?? toPriority(s.priority),
        estimatedDays:
          item.estimatedDays !== undefined
            ? item.estimatedDays
            : (s.estimatedDays ?? null),
        dueDate: item.dueDate ? new Date(item.dueDate) : null,
        milestoneId:
          item.milestoneId ??
          (s.milestone
            ? (milestoneByTitle.get(normalizeTitle(s.milestone)) ?? null)
            : null),
        assignedToId: item.assignedStudentId ?? null,
      };
    });

    const outcome = await this.prisma.$transaction(async (tx) => {
      await this.lockProject(project.id, tx);
      const existingKeyed = await tx.task.findMany({
        where: { sourceKey: { in: prepared.map((p) => p.key) } },
        select: { id: true, sourceKey: true },
      });
      const byKey = new Map(existingKeyed.map((t) => [t.sourceKey!, t.id]));
      const open = await tx.task.findMany({
        where: {
          projectId: project.id,
          status: { not: TaskStatus.CANCELLED },
        },
        select: { id: true, title: true },
      });
      const byTitle = new Map(open.map((t) => [normalizeTitle(t.title), t.id]));

      const createdIds: string[] = [];
      const alreadyApplied: { suggestionId: string; taskId: string }[] = [];
      const skipped: SkippedSuggestionDto[] = [];
      for (const p of prepared) {
        const appliedId = byKey.get(p.key);
        if (appliedId) {
          alreadyApplied.push({
            suggestionId: p.suggestionId,
            taskId: appliedId,
          });
          continue;
        }
        const sameTitle = byTitle.get(normalizeTitle(p.title));
        if (sameTitle) {
          skipped.push({
            suggestionId: p.suggestionId,
            reason: 'DUPLICATE_TITLE',
            existingTaskId: sameTitle,
          });
          continue;
        }
        const task = await tx.task.create({
          data: {
            projectId: project.id,
            title: p.title,
            description: p.description,
            priority: p.priority,
            status: TaskStatus.TODO,
            dueDate: p.dueDate,
            milestoneId: p.milestoneId,
            assignedToId: p.assignedToId,
            estimatedDays: p.estimatedDays,
            source: TaskSource.AI_SUGGESTION,
            sourceKey: p.key,
            createdById: user.id,
          },
          select: { id: true },
        });
        createdIds.push(task.id);
        byTitle.set(normalizeTitle(p.title), task.id);
      }
      return { createdIds, alreadyApplied, skipped };
    });

    const created = await this.tasks.viewsByIds(outcome.createdIds);
    for (const task of created) {
      await this.tasks.notifyAssigned(
        user,
        {
          id: task.id,
          title: task.title,
          projectId: task.projectId,
          assignedToId: task.assignedStudentId,
          dueDate: task.dueDate,
        },
        false,
      );
    }
    return {
      created,
      alreadyApplied: outcome.alreadyApplied,
      skipped: outcome.skipped,
    };
  }

  /** Row lock on the project: concurrent applies of the same answer run one after the other. */
  private async lockProject(projectId: string, db: Db) {
    await db.project.update({
      where: { id: projectId },
      data: { updatedAt: new Date() },
    });
  }
}

function suggestionsOf(
  result: Prisma.JsonValue,
): Map<string, GuidanceTaskSuggestion> {
  const guidance = (result as { guidance?: Guidance } | null)?.guidance;
  const list = Array.isArray(guidance?.taskSuggestions)
    ? guidance!.taskSuggestions
    : [];
  return new Map(
    list.map((s, i) => {
      const id = s.id || `t${i + 1}`; // P13 answers had no ids
      return [id, { ...s, id }];
    }),
  );
}

function toPriority(value: string | undefined): Priority {
  return (Object.values(Priority) as string[]).includes(value ?? '')
    ? (value as Priority)
    : Priority.MEDIUM;
}
