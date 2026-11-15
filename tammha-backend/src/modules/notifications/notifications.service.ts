import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { toPageArgs, toPageMeta } from '@common/dtos/pagination.dto';
import { EmailOutboxService } from './email/email-outbox.service';
import type { NotificationInput } from './notification.types';
import {
  NotificationPageDto,
  NotificationQueryDto,
  NotificationViewDto,
} from './dto/notification.dto';

type Db = PrismaService | Prisma.TransactionClient;

export type { NotificationInput };

export interface CreatedNotification {
  id: string;
  userId: string;
}

const VIEW_SELECT = {
  id: true,
  type: true,
  title: true,
  message: true,
  data: true,
  isRead: true,
  readAt: true,
  createdAt: true,
} satisfies Prisma.NotificationSelect;

/**
 * In-app notifications (+ email outbox for important events).
 *
 * - Pass the transaction client so notifications are saved atomically with the change.
 * - Emails are only RECORDED here (same transaction); they are sent afterwards by the
 *   EmailOutboxService, so an email failure can never prevent or roll back the
 *   in-app notification.
 * - Every read/write API is scoped to the current user's own notifications.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: EmailOutboxService,
  ) {}

  // ==========================================================
  // Writing (used by feature modules and the reminder job)
  // ==========================================================

  async notify(
    userIds: string[],
    input: NotificationInput,
    db: Db = this.prisma,
  ): Promise<CreatedNotification[]> {
    const recipients = [...new Set(userIds)].filter(Boolean);
    return this.notifyEach(
      recipients.map((userId) => ({ userId, input })),
      db,
    );
  }

  /**
   * Many (user, notification) pairs in ONE insert. Pairs whose dedupeKey already exists
   * for that user are skipped; only the newly created ones get an email.
   */
  async notifyEach(
    items: { userId: string; input: NotificationInput }[],
    db: Db = this.prisma,
  ): Promise<CreatedNotification[]> {
    if (items.length === 0) return [];
    const created = await db.notification.createManyAndReturn({
      data: items.map(({ userId, input }) => ({
        userId,
        type: input.type,
        title: input.title,
        message: input.message,
        data: input.data,
        dedupeKey: input.dedupeKey ?? null,
      })),
      skipDuplicates: true,
      select: { id: true, userId: true, dedupeKey: true },
    });

    // Emails for important events (outbox rows, same transaction).
    const byKey = new Map(
      items.map(({ userId, input }) => [`${userId}|${input.dedupeKey}`, input]),
    );
    const byUser = new Map(items.map(({ userId, input }) => [userId, input]));
    const emails = created
      .map((n) => ({
        notification: n,
        input:
          (n.dedupeKey ? byKey.get(`${n.userId}|${n.dedupeKey}`) : undefined) ??
          byUser.get(n.userId)!,
      }))
      .filter((e) => e.input?.email);
    await this.outbox.enqueue(emails, db);

    return created.map(({ id, userId }) => ({ id, userId }));
  }

  // ==========================================================
  // Reading (current user only)
  // ==========================================================

  async list(
    userId: string,
    query: NotificationQueryDto,
    onlyUnread = false,
  ): Promise<NotificationPageDto> {
    const where: Prisma.NotificationWhereInput = {
      userId,
      ...(onlyUnread
        ? { isRead: false }
        : query.isRead !== undefined && { isRead: query.isRead }),
      ...(query.type && { type: query.type }),
    };
    const { page, limit, skip, take } = toPageArgs(query);
    const [total, unreadCount, rows] = await this.prisma.$transaction([
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId, isRead: false } }),
      this.prisma.notification.findMany({
        where,
        select: VIEW_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
    ]);
    return {
      items: rows as NotificationViewDto[],
      meta: toPageMeta(page, limit, total),
      unreadCount,
    };
  }

  async unreadCount(userId: string): Promise<{ unreadCount: number }> {
    return {
      unreadCount: await this.prisma.notification.count({
        where: { userId, isRead: false },
      }),
    };
  }

  /** Idempotent. Another user's notification is reported as not found. */
  async markRead(
    userId: string,
    notificationId: string,
  ): Promise<NotificationViewDto> {
    await this.prisma.notification.updateMany({
      where: { id: notificationId, userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    const row = await this.prisma.notification.findFirst({
      where: { id: notificationId, userId },
      select: VIEW_SELECT,
    });
    if (!row) {
      throw new NotFoundException({
        code: 'NOTIFICATION_NOT_FOUND',
        message: 'Notification not found',
      });
    }
    return row as NotificationViewDto;
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    return { updated: count };
  }
}
