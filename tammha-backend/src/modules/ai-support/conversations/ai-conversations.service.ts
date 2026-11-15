import { Injectable, NotFoundException } from '@nestjs/common';
import { AiMessageRole, AiRequestKind, Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuthUser } from '@common/types/auth-user.type';
import { WorkspaceAccessService } from '@common/workspace/workspace-access.service';
import { toPageArgs, toPageMeta } from '@common/dtos/pagination.dto';
import {
  AI_REQUEST_VIEW_SELECT,
  AISupportService,
  cleanQuestion,
} from '../ai-support.service';
import { GuidanceDto } from '../dto/ai-request.dto';
import {
  AiConversationDetailDto,
  AiConversationPageDto,
  AiConversationQueryDto,
  AiConversationViewDto,
  AiExchangeDto,
  AiMessageViewDto,
  CreateAiConversationDto,
  DEFAULT_CONVERSATION_TITLE,
  RenameAiConversationDto,
  SendAiMessageDto,
} from './ai-conversation.dto';

/** Earlier messages sent back to the model for continuity (most recent N). */
export const AI_HISTORY_MESSAGES = 6;
const HISTORY_CHARS = 800;
const MAX_MESSAGES_RETURNED = 100;

const CONVERSATION_SELECT = {
  id: true,
  projectId: true,
  title: true,
  lastMessageAt: true,
  createdAt: true,
} satisfies Prisma.AiConversationSelect;
type ConversationRow = Prisma.AiConversationGetPayload<{
  select: typeof CONVERSATION_SELECT;
}>;

const MESSAGE_SELECT = {
  id: true,
  role: true,
  content: true,
  kind: true,
  aiRequestId: true,
  guidance: true,
  createdAt: true,
} satisfies Prisma.AiMessageSelect;
type MessageRow = Prisma.AiMessageGetPayload<{ select: typeof MESSAGE_SELECT }>;

const notFound = () =>
  new NotFoundException({
    code: 'AI_CONVERSATION_NOT_FOUND',
    message: 'Conversation not found',
  });

/**
 * AI side chat (P16): conversations scoped to ONE user and ONE project.
 *
 * - Only the owner sees a conversation, and only while they can still access the project
 *   (project access is re-checked on every call; projectId alone is never trusted).
 * - Each message runs the same pipeline as /ai-support/requests (authorization, limits,
 *   project-aware context, handbook excerpts, validated guidance), plus the latest
 *   messages of the conversation for continuity.
 * - Messages are saved only after a successful answer: a failed request leaves the
 *   conversation unchanged (the failed request is still visible in /requests).
 */
@Injectable()
export class AiConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly aiSupport: AISupportService,
  ) {}

  async create(
    user: AuthUser,
    dto: CreateAiConversationDto,
  ): Promise<AiConversationViewDto> {
    const project = await this.access.assertCanViewProject(user, dto.projectId);
    const row = await this.prisma.aiConversation.create({
      data: {
        projectId: project.id,
        userId: user.id,
        title: dto.title || DEFAULT_CONVERSATION_TITLE,
      },
      select: CONVERSATION_SELECT,
    });
    return this.toView(row, 0);
  }

  async list(
    user: AuthUser,
    query: AiConversationQueryDto,
  ): Promise<AiConversationPageDto> {
    const projectIds = query.projectId
      ? [(await this.access.assertCanViewProject(user, query.projectId)).id]
      : await this.access.getReadableProjectIds(user);
    const where: Prisma.AiConversationWhereInput = {
      userId: user.id,
      projectId: { in: projectIds },
    };
    const { page, limit, skip, take } = toPageArgs(query);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.aiConversation.count({ where }),
      this.prisma.aiConversation.findMany({
        where,
        select: CONVERSATION_SELECT,
        orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
    ]);
    const counts = await this.messageCounts(rows.map((r) => r.id));
    return {
      items: rows.map((r) => this.toView(r, counts.get(r.id) ?? 0)),
      meta: toPageMeta(page, limit, total),
    };
  }

  async findOne(user: AuthUser, id: string): Promise<AiConversationDetailDto> {
    const conversation = await this.getOwned(user, id);
    const [messages, counts] = await Promise.all([
      this.prisma.aiMessage.findMany({
        where: { conversationId: conversation.id },
        select: MESSAGE_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_MESSAGES_RETURNED,
      }),
      this.messageCounts([conversation.id]),
    ]);
    // live guidance (shows which task suggestions were applied since)
    const requestIds = messages
      .map((m) => m.aiRequestId)
      .filter((x): x is string => !!x);
    const requests = requestIds.length
      ? await this.aiSupport.toViews(
          await this.prisma.aISupport.findMany({
            where: { id: { in: requestIds }, userId: user.id },
            select: AI_REQUEST_VIEW_SELECT,
          }),
        )
      : [];
    const live = new Map(requests.map((r) => [r.id, r.guidance]));
    return {
      ...this.toView(conversation, counts.get(conversation.id) ?? 0),
      messages: messages.reverse().map((m) => {
        const view = this.toMessage(m);
        const g = m.aiRequestId ? live.get(m.aiRequestId) : undefined;
        return g ? { ...view, guidance: g } : view;
      }),
    };
  }

  async rename(
    user: AuthUser,
    id: string,
    dto: RenameAiConversationDto,
  ): Promise<AiConversationViewDto> {
    const conversation = await this.getOwned(user, id);
    const row = await this.prisma.aiConversation.update({
      where: { id: conversation.id },
      data: { title: dto.title },
      select: CONVERSATION_SELECT,
    });
    const counts = await this.messageCounts([row.id]);
    return this.toView(row, counts.get(row.id) ?? 0);
  }

  async remove(user: AuthUser, id: string): Promise<{ deleted: true }> {
    const conversation = await this.getOwned(user, id);
    // messages cascade; the AI request records (quota history) are kept
    await this.prisma.aiConversation.delete({ where: { id: conversation.id } });
    return { deleted: true };
  }

  /** Ask inside a conversation: one AI request + the two saved messages. */
  async send(
    user: AuthUser,
    id: string,
    dto: SendAiMessageDto,
  ): Promise<AiExchangeDto> {
    const conversation = await this.getOwned(user, id);
    const project = await this.access.assertCanViewProject(
      user,
      conversation.projectId,
    );
    const kind = dto.kind ?? AiRequestKind.PROJECT_QUESTION;
    const feature = this.aiSupport.featureOrThrow(kind);
    const question = cleanQuestion(dto.content);

    const previous = await this.prisma.aiMessage.findMany({
      where: { conversationId: conversation.id },
      select: { role: true, content: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: AI_HISTORY_MESSAGES,
    });
    const history = previous.reverse().map((m) => ({
      role: m.role,
      content: m.content.slice(0, HISTORY_CHARS),
    }));

    // throws (nothing saved in the conversation) when the request fails
    const request = await this.aiSupport.run(user, project, feature, {
      question,
      milestoneId: dto.milestoneId ?? null,
      language: dto.language,
      history,
    });

    const guidance = request.guidance;
    const answer =
      guidance?.answer?.trim() ||
      guidance?.summary?.trim() ||
      'Here is the guidance for your request.';
    const now = Date.now();
    const [userMessage, assistantMessage, updated] =
      await this.prisma.$transaction(async (tx) => {
        const u = await tx.aiMessage.create({
          data: {
            conversationId: conversation.id,
            role: AiMessageRole.USER,
            content: question ?? feature.label,
            kind,
            createdAt: new Date(now),
          },
          select: MESSAGE_SELECT,
        });
        const a = await tx.aiMessage.create({
          data: {
            conversationId: conversation.id,
            role: AiMessageRole.ASSISTANT,
            content: answer,
            kind,
            aiRequestId: request.id,
            guidance: (guidance ?? undefined) as
              Prisma.InputJsonValue | undefined,
            createdAt: new Date(now + 1),
          },
          select: MESSAGE_SELECT,
        });
        const c = await tx.aiConversation.update({
          where: { id: conversation.id },
          data: {
            lastMessageAt: new Date(now + 1),
            ...(conversation.title === DEFAULT_CONVERSATION_TITLE &&
              question && { title: titleFrom(question) }),
          },
          select: CONVERSATION_SELECT,
        });
        return [u, a, c] as const;
      });
    const counts = await this.messageCounts([updated.id]);
    return {
      conversation: this.toView(updated, counts.get(updated.id) ?? 0),
      userMessage: this.toMessage(userMessage),
      assistantMessage: {
        ...this.toMessage(assistantMessage),
        // same view as the request (includes appliedTaskId per suggestion)
        guidance: guidance as GuidanceDto | null,
      },
      request,
    };
  }

  // ==========================================================
  // Internals
  // ==========================================================

  /** Own conversation in a project the user can still access, else 404. */
  private async getOwned(user: AuthUser, id: string): Promise<ConversationRow> {
    const row = await this.prisma.aiConversation.findFirst({
      where: { id, userId: user.id },
      select: CONVERSATION_SELECT,
    });
    if (!row) throw notFound();
    const readable = await this.access.getReadableProjectIds(user);
    if (!readable.includes(row.projectId)) throw notFound();
    return row;
  }

  private async messageCounts(ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.aiMessage.groupBy({
      by: ['conversationId'],
      where: { conversationId: { in: ids } },
      _count: { _all: true },
      orderBy: { conversationId: 'asc' },
    });
    return new Map(
      rows.map((r) => [
        r.conversationId,
        (r._count as { _all?: number } | undefined)?._all ?? 0,
      ]),
    );
  }

  private toView(row: ConversationRow, messageCount: number) {
    return {
      id: row.id,
      projectId: row.projectId,
      title: row.title,
      messageCount,
      lastMessageAt: row.lastMessageAt,
      createdAt: row.createdAt,
    };
  }

  private toMessage(row: MessageRow): AiMessageViewDto {
    return {
      id: row.id,
      role: row.role,
      content: row.content,
      kind: row.kind,
      aiRequestId: row.aiRequestId,
      guidance: (row.guidance as unknown as GuidanceDto | null) ?? null,
      createdAt: row.createdAt,
    };
  }
}

function titleFrom(question: string): string {
  const oneLine = question.replace(/\s+/g, ' ').trim();
  return oneLine.length <= 60 ? oneLine : `${oneLine.slice(0, 59)}…`;
}
