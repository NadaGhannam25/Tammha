import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  GatewayTimeoutException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AISupportStatus,
  AiRequestKind,
  Prisma,
  Project,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuthUser } from '@common/types/auth-user.type';
import { WorkspaceAccessService } from '@common/workspace/workspace-access.service';
import { toPageArgs, toPageMeta } from '@common/dtos/pagination.dto';
import {
  AI_TEXT_PROVIDER,
  AiProviderError,
  AiTextProvider,
} from '@/integrations/ai/ai.provider';
import { integrationDisabled } from '@/integrations/integration-errors';
import { AiSupportSettings, readAiSupportSettings } from './ai-support.config';
import {
  ACTIVE_AI_KINDS,
  AI_FEATURES,
  AiFeature,
} from './features/ai-features';
import {
  buildPrompt,
  PROMPT_VERSION,
  SYSTEM_INSTRUCTION,
} from './features/prompt-builder';
import { ProjectContextService } from './context/project-context.service';
import { HandbookService } from './handbook/handbook.service';
import { ProjectHandbookService } from './handbook/project-handbook.service';
import { loadEffectiveHandbook } from './handbook/handbook-state';
import {
  chunkHandbook,
  HandbookExcerpt,
  selectExcerpts,
} from './handbook/handbook-retrieval';
import {
  Guidance,
  GUIDANCE_RESPONSE_SCHEMA,
  InvalidGuidanceError,
  parseGuidance,
} from './guidance/guidance.schema';
import {
  AiFeatureDto,
  AiLimitsDto,
  AiRequestPageDto,
  AiRequestQueryDto,
  AiRequestViewDto,
  CreateAiRequestDto,
} from './dto/ai-request.dto';
import { ProjectHandbookDto } from './dto/handbook.dto';
import { InvalidExplanationError } from './explanation/handbook-summary.schema';

export const AI_DISCLAIMER =
  'AI-generated guidance for planning only. It does not change grades, scores, readiness, tasks, ' +
  'milestones, project or document status, or supervisor evaluations: task suggestions become tasks ' +
  'only when the team leader applies them. Confirm important decisions with your supervisor and the handbook.';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** An IN_PROGRESS row older than the timeout + this margin is treated as abandoned. */
const IN_FLIGHT_MARGIN_MS = 60_000;

interface StoredResult {
  guidance: Guidance;
  language: 'en' | 'ar';
  promptVersion: string;
  handbook: {
    /** LIBRARY (selected version), PROJECT (leader upload) or UNIVERSITY (default fallback); absent on older rows */
    source?: 'LIBRARY' | 'PROJECT' | 'UNIVERSITY' | null;
    title: string | null;
    excerpts: { id: string; page: number; section: string | null }[];
  };
}

export const AI_REQUEST_VIEW_SELECT = {
  id: true,
  projectId: true,
  kind: true,
  status: true,
  query: true,
  result: true,
  provider: true,
  model: true,
  errorCode: true,
  latencyMs: true,
  handbookExcerpts: true,
  createdAt: true,
  completedAt: true,
} satisfies Prisma.AISupportSelect;
const VIEW_SELECT = AI_REQUEST_VIEW_SELECT;
export type AiRequestRow = Prisma.AISupportGetPayload<{
  select: typeof AI_REQUEST_VIEW_SELECT;
}>;
type RequestRow = AiRequestRow;

/** Options of one AI run (P16: shared by /requests and the side-chat conversations). */
export interface AiRunOptions {
  question: string | null;
  milestoneId?: string | null;
  language?: string;
  /** earlier turns of the same conversation, oldest first */
  history?: { role: 'USER' | 'ASSISTANT'; content: string }[];
}

const err = (code: string, message: string, details?: object) => ({
  code,
  message,
  ...(details && { details }),
});

/**
 * AI Support (P13) — advisory guidance only. This service never writes tasks,
 * milestones, projects, documents, feedback, scores or readiness: its only write is the
 * request record in ai_support.
 *
 * Pipeline: authorize (current project membership) -> validate -> limits (atomic per user)
 * -> minimal project context -> relevant handbook excerpts -> provider (JSON schema,
 * timeout) -> server-side validation -> stored metadata + structured guidance.
 */
@Injectable()
export class AISupportService {
  private readonly logger = new Logger('AISupport');
  readonly settings: AiSupportSettings;
  readonly timeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly contexts: ProjectContextService,
    private readonly universityHandbooks: HandbookService,
    private readonly handbooks: ProjectHandbookService,
    @Inject(AI_TEXT_PROVIDER) private readonly ai: AiTextProvider,
    config: ConfigService,
  ) {
    const env = (k: string) => config.get<string>(k);
    this.settings = readAiSupportSettings({
      AI_USER_HOURLY_LIMIT: env('AI_USER_HOURLY_LIMIT'),
      AI_USER_DAILY_LIMIT: env('AI_USER_DAILY_LIMIT'),
      AI_PROJECT_DAILY_LIMIT: env('AI_PROJECT_DAILY_LIMIT'),
      AI_MAX_OUTPUT_TOKENS: env('AI_MAX_OUTPUT_TOKENS'),
      AI_HANDBOOK_MAX_CHARS: env('AI_HANDBOOK_MAX_CHARS'),
      AI_HANDBOOK_MAX_EXCERPTS: env('AI_HANDBOOK_MAX_EXCERPTS'),
    }).settings;
    const timeout = Number(env('AI_REQUEST_TIMEOUT_MS'));
    this.timeoutMs = Number.isInteger(timeout) && timeout > 0 ? timeout : 30000;
  }

  // ==========================================================
  // Ask
  // ==========================================================

  async ask(
    user: AuthUser,
    dto: CreateAiRequestDto,
  ): Promise<AiRequestViewDto> {
    const feature = this.featureOrThrow(dto.kind);
    // 1. current project membership (students: own team; supervisors: supervised)
    const project = await this.access.assertCanViewProject(user, dto.projectId);
    return this.run(user, project, feature, {
      question: cleanQuestion(dto.question),
      milestoneId: dto.milestoneId ?? null,
      language: dto.language,
    });
  }

  featureOrThrow(kind: AiRequestKind): AiFeature {
    const feature = AI_FEATURES[kind];
    if (!feature) {
      throw new BadRequestException(
        err('AI_KIND_NOT_AVAILABLE', 'This AI feature is not available yet'),
      );
    }
    return feature;
  }

  /**
   * One AI request for a project the caller is already authorized for.
   * Validates the input, reserves quota, builds the project-aware prompt
   * (context + handbook excerpts + optional chat history), calls the provider and stores
   * the validated guidance. Never writes anything else.
   */
  async run(
    user: AuthUser,
    project: Project,
    feature: AiFeature,
    options: AiRunOptions,
  ): Promise<AiRequestViewDto> {
    const question = options.question;
    // Supervisors review projects; they never create or plan the team's tasks, so the
    // task-suggestion feature is students only (supervisor answers carry no task suggestions).
    if (
      user.role === UserRole.SUPERVISOR &&
      feature.kind === AiRequestKind.TASK_BREAKDOWN
    ) {
      throw new ForbiddenException(
        err(
          'AI_FEATURE_NOT_FOR_SUPERVISOR',
          'Task suggestions are available to the project students only',
        ),
      );
    }
    if (feature.requiresQuestion && !question) {
      throw new BadRequestException(
        err('AI_QUESTION_REQUIRED', 'Please type your question'),
      );
    }
    if (options.milestoneId) {
      if (!feature.acceptsMilestone) {
        throw new BadRequestException(
          err(
            'AI_MILESTONE_NOT_SUPPORTED',
            'This AI feature does not take a milestone',
          ),
        );
      }
      await this.contexts.assertMilestoneInProject(
        project.id,
        options.milestoneId,
      );
    }
    // 2. AI configured on this server
    if (!this.ai.isEnabled()) throw integrationDisabled('ai');

    // 3. handbook: the project's active handbook, else the university one (before spending quota)
    const handbook = await this.handbooks.findForAi(project);
    if (feature.requiresHandbook && !handbook) {
      throw new NotFoundException(
        err(
          'HANDBOOK_NOT_FOUND',
          'No handbook is ready for this project yet. The team leader can upload it from the project page.',
        ),
      );
    }

    // 4. limits + record (atomic per user)
    const record = await this.reserve(user, project, feature, question);
    const started = Date.now();
    const language = resolveLanguage(options.language, question);
    let excerpts: HandbookExcerpt[] = [];

    try {
      const context = await this.contexts.build(user, project, {
        includeFeedback: feature.includeFeedback,
        focusMilestoneId: options.milestoneId ?? null,
      });
      if (handbook) {
        const focusTitle = context.milestones.find((m) => m.focus)?.title ?? '';
        excerpts = selectExcerpts(
          chunkHandbook(handbook.extractedText),
          [
            question ?? '',
            feature.handbookKeywords,
            focusTitle,
            context.project.name,
            context.project.description ?? '',
            context.project.overview ?? '',
            context.project.objectives.join(' '),
          ].join(' '),
          {
            maxChars: this.settings.handbookMaxChars,
            maxExcerpts: this.settings.handbookMaxExcerpts,
          },
        );
      }
      const prompt = buildPrompt({
        feature,
        context,
        excerpts,
        handbookTitle: handbook?.title ?? null,
        question,
        language,
        today: new Date(),
        history: options.history,
      });

      const output = await this.ai.generateText({
        system: SYSTEM_INSTRUCTION,
        prompt,
        maxOutputTokens: this.settings.maxOutputTokens,
        responseSchema: GUIDANCE_RESPONSE_SCHEMA as unknown as Record<
          string,
          unknown
        >,
        timeoutMs: this.timeoutMs,
      });
      const guidance = parseGuidance(output.text, excerpts);
      if (user.role === UserRole.SUPERVISOR) guidance.taskSuggestions = [];

      const result: StoredResult = {
        guidance,
        language,
        promptVersion: PROMPT_VERSION,
        handbook: {
          source: handbook?.source ?? null,
          title: handbook?.title ?? null,
          excerpts: excerpts.map((e) => ({
            id: e.id,
            page: e.page,
            section: e.heading,
          })),
        },
      };
      const used = excerpts.length > 0 && handbook;
      const saved = await this.prisma.aISupport.update({
        where: { id: record.id },
        data: {
          status: AISupportStatus.COMPLETED,
          result: result as unknown as Prisma.InputJsonValue,
          provider: output.provider,
          model: output.model,
          latencyMs: Date.now() - started,
          inputTokens: output.usage?.inputTokens ?? null,
          outputTokens: output.usage?.outputTokens ?? null,
          handbookId:
            used && handbook.source !== 'PROJECT' ? handbook.id : null,
          projectHandbookId:
            used && handbook.source === 'PROJECT' ? handbook.id : null,
          handbookExcerpts: excerpts.length,
          completedAt: new Date(),
        },
        select: VIEW_SELECT,
      });
      return (await this.toViews([saved]))[0];
    } catch (error) {
      const { code, http } = this.mapError(error);
      await this.prisma.aISupport
        .update({
          where: { id: record.id },
          data: {
            status: AISupportStatus.FAILED,
            errorCode: code,
            latencyMs: Date.now() - started,
            handbookExcerpts: excerpts.length,
            completedAt: new Date(),
          },
        })
        .catch(() =>
          this.logger.error(`could not mark AI request ${record.id} as failed`),
        );
      this.logger.warn(
        `AI request ${record.id} (${feature.kind}) failed: ${code}`,
      );
      throw http;
    }
  }

  // ==========================================================
  // Reads (own requests, projects the user can still access)
  // ==========================================================

  async list(
    user: AuthUser,
    query: AiRequestQueryDto,
  ): Promise<AiRequestPageDto> {
    const projectIds = query.projectId
      ? [(await this.access.assertCanViewProject(user, query.projectId)).id]
      : await this.access.getReadableProjectIds(user);
    const where: Prisma.AISupportWhereInput = {
      userId: user.id,
      projectId: { in: projectIds },
      ...(query.kind && { kind: query.kind }),
    };
    const { page, limit, skip, take } = toPageArgs(query);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.aISupport.count({ where }),
      this.prisma.aISupport.findMany({
        where,
        select: VIEW_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
    ]);
    return {
      items: await this.toViews(rows),
      meta: toPageMeta(page, limit, total),
    };
  }

  async findOne(user: AuthUser, id: string): Promise<AiRequestViewDto> {
    const projectIds = await this.access.getReadableProjectIds(user);
    const row = await this.prisma.aISupport.findFirst({
      where: { id, userId: user.id, projectId: { in: projectIds } },
      select: VIEW_SELECT,
    });
    if (!row) {
      throw new NotFoundException(
        err('AI_REQUEST_NOT_FOUND', 'AI request not found'),
      );
    }
    return (await this.toViews([row]))[0];
  }

  async limits(user: AuthUser, projectId: string): Promise<AiLimitsDto> {
    await this.access.assertCanViewProject(user, projectId);
    const now = Date.now();
    const hourFrom = new Date(now - HOUR_MS);
    const dayFrom = new Date(now - DAY_MS);
    // the oldest request inside each window decides when one slot frees up
    const oldest = (where: Prisma.AISupportWhereInput) =>
      this.prisma.aISupport.findFirst({
        where,
        select: { createdAt: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
    const [hour, day, project, oldestHour, oldestDay, oldestProject] =
      await Promise.all([
        this.prisma.aISupport.count({
          where: { userId: user.id, createdAt: { gte: hourFrom } },
        }),
        this.prisma.aISupport.count({
          where: { userId: user.id, createdAt: { gte: dayFrom } },
        }),
        this.prisma.aISupport.count({
          where: { projectId, createdAt: { gte: dayFrom } },
        }),
        oldest({ userId: user.id, createdAt: { gte: hourFrom } }),
        oldest({ userId: user.id, createdAt: { gte: dayFrom } }),
        oldest({ projectId, createdAt: { gte: dayFrom } }),
      ]);
    const q = (
      limit: number,
      used: number,
      first: { createdAt: Date } | null,
      windowMs: number,
    ) => ({
      limit,
      used,
      remaining: Math.max(0, limit - used),
      window: windowMs === HOUR_MS ? ('1h' as const) : ('24h' as const),
      resetsAt: first ? new Date(first.createdAt.getTime() + windowMs) : null,
    });
    return {
      enabled: this.ai.isEnabled(),
      hourly: q(this.settings.userHourlyLimit, hour, oldestHour, HOUR_MS),
      daily: q(this.settings.userDailyLimit, day, oldestDay, DAY_MS),
      project: q(
        this.settings.projectDailyLimit,
        project,
        oldestProject,
        DAY_MS,
      ),
      countsHandbookProcessing: false,
    };
  }

  /** Which handbook the AI uses for this project (metadata only). */
  async projectHandbook(
    user: AuthUser,
    projectId: string,
  ): Promise<ProjectHandbookDto> {
    const project = await this.access.assertCanViewProject(user, projectId);
    const effective = await loadEffectiveHandbook(this.prisma, project.id);
    if (effective.source === 'LIBRARY' && effective.libraryVersion) {
      return {
        available: true,
        source: 'LIBRARY',
        title: effective.libraryVersion.title,
        pageCount: effective.libraryVersion.pageCount,
        updatedAt: null,
      };
    }
    const own = await this.prisma.projectHandbook.findFirst({
      where: { projectId: project.id, isActive: true, status: 'READY' },
      select: { title: true, pageCount: true, updatedAt: true },
    });
    if (own) {
      return {
        available: true,
        source: 'PROJECT',
        title: own.title,
        pageCount: own.pageCount,
        updatedAt: own.updatedAt,
      };
    }
    // only the handbook selected for this project is used (no fallback)
    return {
      available: false,
      source: null,
      title: null,
      pageCount: null,
      updatedAt: null,
    };
  }

  features(): AiFeatureDto[] {
    return ACTIVE_AI_KINDS.map((kind) => {
      const f = AI_FEATURES[kind]!;
      return {
        kind,
        label: f.label,
        requiresQuestion: f.requiresQuestion,
        requiresHandbook: f.requiresHandbook,
        acceptsMilestone: f.acceptsMilestone,
      };
    });
  }

  // ==========================================================
  // Internals
  // ==========================================================

  /**
   * Checks the limits and creates the IN_PROGRESS record in ONE transaction holding a
   * per-user PostgreSQL advisory lock, so parallel requests cannot slip past the limits.
   */
  async reserve(
    user: AuthUser,
    project: { id: string } | null,
    feature: Pick<AiFeature, 'kind' | 'category' | 'label'>,
    question: string | null,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const lockKey = `ai-support:${user.id}`;
      await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${lockKey}))) AS l`;

      const now = Date.now();
      const [inFlight, hourRows, dayCount, projectCount] = await Promise.all([
        tx.aISupport.count({
          where: {
            userId: user.id,
            status: {
              in: [AISupportStatus.PENDING, AISupportStatus.IN_PROGRESS],
            },
            createdAt: {
              gte: new Date(now - this.timeoutMs - IN_FLIGHT_MARGIN_MS),
            },
          },
        }),
        tx.aISupport.findMany({
          where: {
            userId: user.id,
            createdAt: { gte: new Date(now - HOUR_MS) },
          },
          select: { createdAt: true },
          orderBy: { createdAt: 'asc' },
          take: this.settings.userHourlyLimit,
        }),
        tx.aISupport.count({
          where: {
            userId: user.id,
            createdAt: { gte: new Date(now - DAY_MS) },
          },
        }),
        project
          ? tx.aISupport.count({
              where: {
                projectId: project.id,
                createdAt: { gte: new Date(now - DAY_MS) },
              },
            })
          : Promise.resolve(0),
      ]);

      if (inFlight > 0) {
        throw new HttpException(
          err(
            'AI_REQUEST_IN_PROGRESS',
            'Please wait for your previous AI request to finish',
          ),
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      const limited = (
        scope: string,
        message: string,
        retryAfterSeconds: number,
      ) =>
        new HttpException(
          err('AI_RATE_LIMITED', message, { scope, retryAfterSeconds }),
          HttpStatus.TOO_MANY_REQUESTS,
        );
      if (hourRows.length >= this.settings.userHourlyLimit) {
        const retry = Math.ceil(
          (hourRows[0].createdAt.getTime() + HOUR_MS - now) / 1000,
        );
        throw limited(
          'user_hourly',
          `You can send ${this.settings.userHourlyLimit} AI requests per hour`,
          Math.max(1, retry),
        );
      }
      if (dayCount >= this.settings.userDailyLimit) {
        throw limited(
          'user_daily',
          `You can send ${this.settings.userDailyLimit} AI requests per day`,
          3600,
        );
      }
      if (projectCount >= this.settings.projectDailyLimit) {
        throw limited(
          'project_daily',
          `This project reached its ${this.settings.projectDailyLimit} AI requests for today`,
          3600,
        );
      }

      return tx.aISupport.create({
        data: {
          userId: user.id,
          projectId: project?.id ?? null,
          kind: feature.kind,
          category: feature.category,
          query: question ?? feature.label,
          status: AISupportStatus.IN_PROGRESS,
          // same clock as the limit windows above
          createdAt: new Date(now),
          provider: this.ai.name === 'disabled' ? null : this.ai.name,
          model: this.ai.model,
        },
        select: { id: true },
      });
    });
  }

  /** Stable error code for the record + a safe HTTP error for the client. */
  mapError(error: unknown): { code: string; http: HttpException } {
    if (error instanceof AiProviderError) {
      const code = error.code;
      switch (code) {
        case 'AI_PROVIDER_TIMEOUT':
          return {
            code,
            http: new GatewayTimeoutException(
              err(
                code,
                'The AI service took too long to answer. Please try again.',
              ),
            ),
          };
        case 'AI_PROVIDER_UNAVAILABLE':
        case 'AI_PROVIDER_RATE_LIMITED':
          return {
            code,
            http: new ServiceUnavailableException(
              err(
                'AI_PROVIDER_UNAVAILABLE',
                'The AI service is busy or unavailable. Please try again later.',
              ),
            ),
          };
        case 'AI_RESPONSE_BLOCKED':
          return {
            code,
            http: new UnprocessableEntityException(
              err(
                code,
                'The AI service declined to answer this request. Please rephrase it.',
              ),
            ),
          };
        case 'AI_PROVIDER_REJECTED':
          return {
            code,
            http: new BadGatewayException(
              err(
                'AI_PROVIDER_ERROR',
                'The AI service is not configured correctly. Please contact the administrator.',
              ),
            ),
          };
        default:
          return {
            code,
            http: new BadGatewayException(
              err(
                'AI_INVALID_RESPONSE',
                'The AI service returned an unusable answer. Please try again.',
              ),
            ),
          };
      }
    }
    if (
      error instanceof InvalidGuidanceError ||
      error instanceof InvalidExplanationError
    ) {
      return {
        code: 'AI_INVALID_RESPONSE',
        http: new BadGatewayException(
          err(
            'AI_INVALID_RESPONSE',
            'The AI service returned an unusable answer. Please try again.',
          ),
        ),
      };
    }
    if (error instanceof HttpException) {
      const body = error.getResponse() as { code?: string };
      return { code: body?.code ?? `HTTP_${error.getStatus()}`, http: error };
    }
    return {
      code: 'AI_INTERNAL_ERROR',
      http: new BadGatewayException(
        err(
          'AI_PROVIDER_ERROR',
          'The AI request could not be completed. Please try again.',
        ),
      ),
    };
  }

  /**
   * Views of stored requests. For TASK_BREAKDOWN, each suggestion shows the task that was
   * created from it (appliedTaskId), so the UI can mark applied suggestions.
   */
  async toViews(rows: RequestRow[]): Promise<AiRequestViewDto[]> {
    const keys: string[] = [];
    for (const row of rows) {
      const result = row.result as unknown as StoredResult | null;
      for (const t of result?.guidance?.taskSuggestions ?? []) {
        if (t.id) keys.push(`${row.id}:${t.id}`);
      }
    }
    const applied = new Map<string, string>();
    if (keys.length > 0) {
      const tasks = await this.prisma.task.findMany({
        where: { sourceKey: { in: keys } },
        select: { id: true, sourceKey: true },
      });
      for (const t of tasks) if (t.sourceKey) applied.set(t.sourceKey, t.id);
    }
    return rows.map((row) => this.toView(row, applied));
  }

  private toView(
    row: RequestRow,
    applied: Map<string, string>,
  ): AiRequestViewDto {
    const result = row.result as unknown as StoredResult | null;
    const guidance = result?.guidance
      ? {
          ...result.guidance,
          taskSuggestions: (result.guidance.taskSuggestions ?? []).map(
            (t, i) => {
              const id = t.id || `t${i + 1}`;
              return {
                ...t,
                id,
                priority: t.priority ?? 'MEDIUM',
                appliedTaskId: applied.get(`${row.id}:${id}`) ?? null,
              };
            },
          ),
        }
      : null;
    return {
      id: row.id,
      projectId: row.projectId,
      kind: row.kind,
      status: row.status,
      question:
        row.kind === AiRequestKind.PROJECT_QUESTION || isUserQuestion(row.query)
          ? row.query
          : null,
      language: result?.language ?? null,
      guidance,
      handbook: {
        used: row.handbookExcerpts > 0,
        source:
          result?.handbook.source ??
          (row.handbookExcerpts > 0 ? 'UNIVERSITY' : null),
        title: result?.handbook.title ?? null,
        excerptsUsed: row.handbookExcerpts,
      },
      provider: row.provider,
      model: row.model,
      errorCode: row.errorCode,
      latencyMs: row.latencyMs,
      advisoryOnly: true,
      disclaimer: AI_DISCLAIMER,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
    };
  }
}

const FEATURE_LABELS = new Set([
  ...Object.values(AI_FEATURES).map((f) => f!.label),
  'University handbook guidance', // label stored by P13 rows
]);
/** `query` holds the question, or the feature label when there was none. */
function isUserQuestion(query: string): boolean {
  return !FEATURE_LABELS.has(query);
}

export function cleanQuestion(question: string | undefined): string | null {
  const q = (question ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  return q || null;
}

function resolveLanguage(
  requested: string | undefined,
  question: string | null,
): 'en' | 'ar' {
  if (requested === 'en' || requested === 'ar') return requested;
  return question && /[؀-ۿ]/.test(question) ? 'ar' : 'en';
}
