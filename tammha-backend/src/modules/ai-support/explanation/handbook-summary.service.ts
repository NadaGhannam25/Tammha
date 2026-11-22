import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AISupportCategory,
  AISupportStatus,
  AiRequestKind,
  HandbookStatus,
  Prisma,
  TaskStatus,
  TeamRole,
} from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuthUser } from '@common/types/auth-user.type';
import { WorkspaceAccessService } from '@common/workspace/workspace-access.service';
import {
  AI_TEXT_PROVIDER,
  AiProviderError,
  AiTextProvider,
  AiTextRequest,
  AiTextResult,
} from '@/integrations/ai/ai.provider';
import { integrationDisabled } from '@/integrations/integration-errors';
import { AISupportService } from '../ai-support.service';
import { loadEffectiveHandbook } from '../handbook/handbook-state';
import type { Guidance } from '../guidance/guidance.schema';
import {
  buildHandbookTasksPrompt,
  buildSummaryPrompt,
  HANDBOOK_TASKS_PROMPT_VERSION,
  HANDBOOK_TASKS_RESPONSE_SCHEMA,
  HANDBOOK_TASKS_SYSTEM_INSTRUCTION,
  handbookPagesForPrompt,
  InvalidExplanationError,
  taskPagesForPrompt,
  parseHandbookTasks,
  parseSummary,
  SUMMARY_PROMPT_VERSION,
  SUMMARY_RESPONSE_SCHEMA,
  SUMMARY_SYSTEM_INSTRUCTION,
} from './handbook-summary.schema';
import {
  HandbookAiRefDto,
  HandbookSummaryViewDto,
  HandbookTasksResultDto,
} from './handbook-summary.dto';

export const SUMMARY_DISCLAIMER =
  'AI summary of the handbook text, with page references. It does not replace the handbook: ' +
  'check important requirements on the cited pages and with your supervisor. Grading information ' +
  'is shown for reference only; Tammha does not grade students.';

const err = (code: string, message: string) => ({ code, message });

/** Task extraction: at most this much handbook text per request, and a longer time limit. */
const TASKS_MAX_CHARS = 60_000;
const TASKS_TIMEOUT_MS = 140_000;
/** The summary of seven topics needs room: thinking tokens count against this limit. */
const SUMMARY_MIN_OUTPUT_TOKENS = 16_384;
/** Answers worth asking for once more: cut off, empty or not usable JSON. */
const RETRY_CODES = new Set([
  'AI_RESPONSE_TRUNCATED',
  'AI_EMPTY_RESPONSE',
  'AI_INVALID_RESPONSE',
]);

const SUMMARY_FEATURE = {
  // stored under the existing enum value (no migration): the record is the summary request
  kind: AiRequestKind.HANDBOOK_EXPLANATION,
  category: AISupportCategory.DOCUMENTATION_HELP,
  label: 'Handbook summary',
};
const TASKS_FEATURE = {
  kind: AiRequestKind.TASK_BREAKDOWN,
  category: AISupportCategory.TASK_PLANNING,
  label: 'Handbook task extraction',
};

interface Target {
  source: 'LIBRARY' | 'PROJECT';
  id: string;
  title: string;
  fileName: string;
  universityName: string | null;
  pageCount: number | null;
  projectId: string;
}

/**
 * The project's SELECTED handbook (a university's official PDF, or the project's own upload)
 * for two AI actions:
 *  - SUMMARY: the seven fixed topics (handbook-summary.schema.ts), cached per handbook and
 *    language (handbook_explanations table) so a handbook costs one AI call per language;
 *  - TASKS: task suggestions taken from the handbook, stored as a COMPLETED AI request so the
 *    team leader applies the selected ones with the existing apply endpoint (idempotent,
 *    duplicate titles skipped). Nothing is created automatically.
 * Only the selected handbook of THIS project is ever sent; access is checked per project.
 */
@Injectable()
export class HandbookSummaryService {
  private readonly logger = new Logger('HandbookAI');

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly aiSupport: AISupportService,
    @Inject(AI_TEXT_PROVIDER) private readonly ai: AiTextProvider,
  ) {}

  // ==========================================================
  // Summary (project students + its supervisor)
  // ==========================================================

  async getSummary(
    user: AuthUser,
    projectId: string,
    language: 'ar' | 'en' = 'ar',
  ): Promise<HandbookSummaryViewDto> {
    const project = await this.access.assertCanViewProject(user, projectId);
    return this.view(await this.target(project.id), language);
  }

  async generateSummary(
    user: AuthUser,
    projectId: string,
    language: 'ar' | 'en' = 'ar',
    regenerate = false,
  ): Promise<HandbookSummaryViewDto> {
    const project = await this.access.assertCanViewProject(user, projectId);
    const target = await this.target(project.id);
    if (!regenerate) {
      const cached = await this.view(target, language);
      if (cached.status === 'READY') return cached; // no AI call, no quota
    }
    if (!this.ai.isEnabled()) throw integrationDisabled('ai');
    const text = await this.text(target);
    const record = await this.aiSupport.reserve(
      user,
      { id: project.id },
      SUMMARY_FEATURE,
      null,
    );
    const started = Date.now();
    const { pages, pageCount, truncated } = handbookPagesForPrompt(
      text,
      this.aiSupport.settings.handbookExplainMaxChars,
    );
    try {
      const { output, value: summary } = await this.generate(
        {
          system: SUMMARY_SYSTEM_INSTRUCTION,
          prompt: buildSummaryPrompt({
            title: target.title,
            language,
            pages,
            truncated,
          }),
          maxOutputTokens: Math.max(
            this.aiSupport.settings.explainMaxOutputTokens,
            SUMMARY_MIN_OUTPUT_TOKENS,
          ),
          responseSchema: SUMMARY_RESPONSE_SCHEMA as unknown as Record<
            string,
            unknown
          >,
          timeoutMs: Math.max(this.aiSupport.timeoutMs, 90_000),
          lightThinking: true,
        },
        (raw) => parseSummary(raw, pages),
      );
      const data = {
        result: summary as unknown as Prisma.InputJsonValue,
        promptVersion: SUMMARY_PROMPT_VERSION,
        provider: output.provider,
        model: output.model,
        pageCount: target.pageCount ?? pageCount,
        pagesIncluded: pages.length,
        truncated,
        createdById: user.id,
      };
      const where = this.where(target, language);
      const existing = await this.prisma.handbookExplanation.findFirst({
        where,
        select: { id: true },
      });
      if (existing) {
        await this.prisma.handbookExplanation.update({
          where: { id: existing.id },
          data,
        });
      } else {
        await this.prisma.handbookExplanation.create({
          data: { ...where, ...data },
        });
      }
      await this.complete(record.id, target, started, output, {
        type: 'HANDBOOK_SUMMARY',
        language,
        handbook: { source: target.source, title: target.title },
        stats: summary.stats,
      });
      return this.view(target, language);
    } catch (error) {
      throw await this.fail(record.id, target, started, error, 'summary');
    }
  }

  // ==========================================================
  // Task extraction (students of the project)
  // ==========================================================

  async extractTasks(
    user: AuthUser,
    projectId: string,
    language: 'ar' | 'en' = 'ar',
  ): Promise<HandbookTasksResultDto> {
    const project = await this.access.assertStudentOfProject(user, projectId);
    const target = await this.target(project.id);
    if (!this.ai.isEnabled()) throw integrationDisabled('ai');
    const text = await this.text(target);
    const membership = await this.access.findMembershipInTeam(
      user.id,
      project.teamId,
    );
    const existing = (
      await this.prisma.task.findMany({
        where: { projectId: project.id, status: { not: TaskStatus.CANCELLED } },
        select: { title: true },
        take: 300,
      })
    ).map((t) => t.title);

    const record = await this.aiSupport.reserve(
      user,
      { id: project.id },
      TASKS_FEATURE,
      null,
    );
    const started = Date.now();
    const { pages, pageCount, truncated } = taskPagesForPrompt(
      text,
      await this.summaryPages(target),
      Math.min(
        this.aiSupport.settings.handbookExplainMaxChars,
        TASKS_MAX_CHARS,
      ),
    );
    try {
      const {
        output,
        value: { suggestions, dropped },
      } = await this.generate(
        {
          system: HANDBOOK_TASKS_SYSTEM_INSTRUCTION,
          prompt: buildHandbookTasksPrompt({
            title: target.title,
            language,
            pages,
            truncated,
            existingTasks: existing,
          }),
          maxOutputTokens: Math.max(
            this.aiSupport.settings.explainMaxOutputTokens,
            SUMMARY_MIN_OUTPUT_TOKENS,
          ),
          responseSchema: HANDBOOK_TASKS_RESPONSE_SCHEMA as unknown as Record<
            string,
            unknown
          >,
          timeoutMs: Math.max(this.aiSupport.timeoutMs, TASKS_TIMEOUT_MS),
          lightThinking: true,
        },
        (raw) => parseHandbookTasks(raw, pages, existing),
      );
      // Stored in the guidance shape the apply endpoint reads (taskSuggestions with ids).
      const guidance: Guidance = {
        summary: '',
        answer: null,
        recommendations: [],
        nextSteps: [],
        taskSuggestions: suggestions.map((s) => ({
          id: s.id,
          title: s.title,
          description: s.description,
          priority: s.priority,
          estimatedDays: s.estimatedDays,
          milestone: null,
        })),
        milestoneSuggestions: [],
        handbookReferences: [],
        risks: [],
        confidence: 'MEDIUM',
      };
      await this.complete(record.id, target, started, output, {
        type: 'HANDBOOK_TASKS',
        promptVersion: HANDBOOK_TASKS_PROMPT_VERSION,
        language,
        guidance,
        handbook: { source: target.source, title: target.title },
        references: Object.fromEntries(
          suggestions.map((s) => [s.id, { pages: s.pages, quote: s.quote }]),
        ),
        dropped,
      });
      return {
        aiRequestId: record.id,
        handbook: this.ref(target),
        suggestions,
        dropped,
        coverage: {
          pagesIncluded: pages.length,
          pageCount: target.pageCount ?? pageCount,
          truncated,
        },
        // every student of the team applies suggested tasks
        canApply: !!membership,
        advisoryOnly: true,
      };
    } catch (error) {
      throw await this.fail(record.id, target, started, error, 'tasks');
    }
  }

  // ==========================================================
  // Internals
  // ==========================================================

  /**
   * Asks the model and parses the answer. An answer that was cut off, empty or not usable
   * is asked for once more (with twice the output room) before the request fails, so a
   * single bad answer never reaches the student as an error.
   */
  private async generate<T>(
    request: AiTextRequest,
    parse: (raw: string) => T,
  ): Promise<{ output: AiTextResult; value: T }> {
    for (let attempt = 1; ; attempt++) {
      try {
        const output = await this.ai.generateText(
          attempt === 1
            ? request
            : {
                ...request,
                maxOutputTokens: (request.maxOutputTokens ?? 8192) * 2,
              },
        );
        return { output, value: parse(output.text) };
      } catch (error) {
        const code =
          error instanceof AiProviderError
            ? error.code
            : error instanceof InvalidExplanationError
              ? 'AI_INVALID_RESPONSE'
              : '';
        if (attempt >= 2 || !RETRY_CODES.has(code)) throw error;
        this.logger.warn(`handbook AI answer unusable (${code}); asking again`);
      }
    }
  }

  /** The project's selected, READY handbook (404 HANDBOOK_NOT_FOUND otherwise). */
  private async target(projectId: string): Promise<Target> {
    const effective = await loadEffectiveHandbook(this.prisma, projectId);
    if (
      effective.source === 'LIBRARY' &&
      effective.state === 'READY' &&
      effective.libraryVersion
    ) {
      const v = effective.libraryVersion;
      return {
        source: 'LIBRARY',
        id: v.id,
        title: v.title,
        fileName: v.fileName,
        universityName: v.universityName || null,
        pageCount: v.pageCount,
        projectId,
      };
    }
    if (effective.source === 'UPLOAD') {
      const own = await this.prisma.projectHandbook.findFirst({
        where: { projectId, isActive: true, status: HandbookStatus.READY },
        select: {
          id: true,
          title: true,
          fileName: true,
          pageCount: true,
        },
      });
      if (own) {
        return {
          source: 'PROJECT',
          id: own.id,
          title: own.title,
          fileName: own.fileName,
          universityName: null,
          pageCount: own.pageCount,
          projectId,
        };
      }
    }
    throw new NotFoundException(
      err(
        'HANDBOOK_NOT_FOUND',
        effective.state === 'PROCESSING'
          ? 'The handbook is still being processed. Try again in a moment.'
          : effective.state === 'FAILED'
            ? 'The uploaded handbook could not be read. Upload a text-based PDF.'
            : "This project has no handbook yet: choose a university's handbook or upload one.",
      ),
    );
  }

  private async text(target: Target): Promise<string> {
    const row =
      target.source === 'LIBRARY'
        ? await this.prisma.universityHandbook.findUnique({
            where: { id: target.id },
            select: { extractedText: true },
          })
        : await this.prisma.projectHandbook.findUnique({
            where: { id: target.id },
            select: { extractedText: true },
          });
    const text = row?.extractedText ?? '';
    if (!text.trim()) {
      throw new ConflictException(
        err('HANDBOOK_NOT_READABLE', 'This handbook has no readable text'),
      );
    }
    return text;
  }

  private ref(target: Target): HandbookAiRefDto {
    return {
      source: target.source,
      id: target.id,
      title: target.title,
      fileName: target.fileName,
      universityName: target.universityName,
    };
  }

  private where(target: Target, language: string) {
    return target.source === 'LIBRARY'
      ? { universityHandbookId: target.id, language }
      : { projectHandbookId: target.id, language };
  }

  /** Pages cited by a stored summary of this handbook (either language); [] when none. */
  private async summaryPages(target: Target): Promise<number[]> {
    const rows = await this.prisma.handbookExplanation.findMany({
      where:
        target.source === 'LIBRARY'
          ? { universityHandbookId: target.id }
          : { projectHandbookId: target.id },
      select: { result: true, promptVersion: true },
      take: 2,
    });
    const pages = new Set<number>();
    for (const row of rows) {
      if (row.promptVersion !== SUMMARY_PROMPT_VERSION) continue;
      const topics =
        (
          row.result as {
            topics?: { pages?: number[]; points?: { pages?: number[] }[] }[];
          } | null
        )?.topics ?? [];
      for (const t of topics) {
        (t.pages ?? []).forEach((p) => pages.add(p));
        (t.points ?? []).forEach((pt) =>
          (pt.pages ?? []).forEach((p) => pages.add(p)),
        );
      }
    }
    return [...pages].sort((a, b) => a - b);
  }

  private async view(
    target: Target,
    language: 'ar' | 'en',
  ): Promise<HandbookSummaryViewDto> {
    const row = await this.prisma.handbookExplanation.findFirst({
      where: this.where(target, language),
    });
    // a cached answer of an older prompt (e.g. the earlier free-form explanation) is not shown
    const ready = !!row && row.promptVersion === SUMMARY_PROMPT_VERSION;
    const result = ready
      ? (row.result as unknown as {
          topics: HandbookSummaryViewDto['topics'];
          stats: HandbookSummaryViewDto['stats'];
        })
      : null;
    return {
      status: ready ? 'READY' : 'NOT_GENERATED',
      language,
      handbook: this.ref(target),
      topics: result?.topics ?? [],
      stats: result?.stats ?? null,
      coverage: ready
        ? {
            pagesIncluded: row.pagesIncluded,
            pageCount: row.pageCount,
            truncated: row.truncated,
          }
        : null,
      generatedAt: ready ? row.updatedAt : null,
      model: ready ? row.model : null,
      advisoryOnly: true,
      disclaimer: SUMMARY_DISCLAIMER,
    };
  }

  private async complete(
    recordId: string,
    target: Target,
    started: number,
    output: {
      provider: string;
      model: string;
      usage?: { inputTokens?: number; outputTokens?: number };
    },
    result: Record<string, unknown>,
  ) {
    await this.prisma.aISupport.update({
      where: { id: recordId },
      data: {
        status: AISupportStatus.COMPLETED,
        result: result as Prisma.InputJsonValue,
        provider: output.provider,
        model: output.model,
        latencyMs: Date.now() - started,
        inputTokens: output.usage?.inputTokens ?? null,
        outputTokens: output.usage?.outputTokens ?? null,
        handbookId: target.source === 'LIBRARY' ? target.id : null,
        projectHandbookId: target.source === 'PROJECT' ? target.id : null,
        completedAt: new Date(),
      },
    });
  }

  private async fail(
    recordId: string,
    target: Target,
    started: number,
    error: unknown,
    what: string,
  ) {
    const { code, http } = this.aiSupport.mapError(error);
    await this.prisma.aISupport
      .update({
        where: { id: recordId },
        data: {
          status: AISupportStatus.FAILED,
          errorCode: code,
          latencyMs: Date.now() - started,
          completedAt: new Date(),
        },
      })
      .catch(() =>
        this.logger.error(`could not mark AI request ${recordId} as failed`),
      );
    this.logger.warn(
      `handbook ${what} ${target.source}:${target.id} failed: ${code}`,
    );
    return http;
  }
}
