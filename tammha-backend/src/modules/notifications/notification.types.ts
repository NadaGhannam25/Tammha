import { NotificationType, Prisma } from '@prisma/client';

export interface NotificationInput {
  type: NotificationType;
  title: string;
  message: string;
  /** Machine-readable context for the frontend (ids, kind). Never secrets or hidden scores. */
  data?: Prisma.InputJsonValue;
  /**
   * Identifies the event. The same key is stored at most once per user
   * (unique userId + dedupeKey), so reminders and retried events never duplicate.
   */
  dedupeKey?: string;
  /** Important event: also send an email (only when email delivery is enabled). */
  email?: boolean;
}
