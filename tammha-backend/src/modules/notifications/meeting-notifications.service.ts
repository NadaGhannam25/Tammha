import { Injectable } from '@nestjs/common';
import { NotificationType, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { NotificationsService } from './notifications.service';

type Db = PrismaService | Prisma.TransactionClient;

export type MeetingChange = 'SCHEDULED' | 'UPDATED' | 'CANCELLED';

const TYPE: Record<MeetingChange, NotificationType> = {
  SCHEDULED: NotificationType.MEETING_INVITATION,
  UPDATED: NotificationType.MEETING_UPDATED,
  CANCELLED: NotificationType.MEETING_CANCELLED,
};

const formatWhen = (d: Date) =>
  `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/**
 * Meeting events (scheduled / updated / cancelled). The meetings service (P12) calls
 * notifyMeetingChange() inside its transaction. Recipients: the meeting's
 * attendees, or — when none are listed — every student of the team and the supervisor.
 * The person who made the change is not notified. Always emailed (important event).
 */
@Injectable()
export class MeetingNotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async notifyMeetingChange(
    meetingId: string,
    change: MeetingChange,
    actorId: string | null,
    db: Db = this.prisma,
  ) {
    const meeting = await db.meeting.findUnique({
      where: { id: meetingId },
      select: {
        id: true,
        title: true,
        scheduledAt: true,
        duration: true,
        location: true,
        projectId: true,
        updatedAt: true,
        attendees: { select: { userId: true } },
        project: { select: { teamId: true } },
      },
    });
    if (!meeting) return [];

    let recipients = meeting.attendees.map((a) => a.userId);
    if (recipients.length === 0) {
      const [students, supervisors] = await Promise.all([
        db.teamMember.findMany({
          where: { teamId: meeting.project.teamId },
          select: { userId: true },
        }),
        db.projectMember.findMany({
          where: {
            projectId: meeting.projectId,
            user: { role: UserRole.SUPERVISOR },
          },
          select: { userId: true },
        }),
      ]);
      recipients = [...students, ...supervisors].map((m) => m.userId);
    }
    recipients = recipients.filter((id) => id !== actorId);

    const when = formatWhen(meeting.scheduledAt);
    const where = meeting.location ? ` (${meeting.location})` : '';
    const message = {
      SCHEDULED: `"${meeting.title}" is scheduled for ${when}${where}.`,
      UPDATED: `"${meeting.title}" was changed. It is now on ${when}${where}.`,
      CANCELLED: `"${meeting.title}" on ${when} was cancelled.`,
    }[change];
    const title = {
      SCHEDULED: 'Meeting scheduled',
      UPDATED: 'Meeting updated',
      CANCELLED: 'Meeting cancelled',
    }[change];

    return this.notifications.notify(
      recipients,
      {
        type: TYPE[change],
        title,
        message,
        data: {
          kind: `meeting_${change.toLowerCase()}`,
          meetingTitle: meeting.title,
          meetingId: meeting.id,
          projectId: meeting.projectId,
          scheduledAt: meeting.scheduledAt.toISOString(),
          duration: meeting.duration,
        },
        // a new key for every change of the meeting; repeats of the same change are skipped
        dedupeKey: `meeting:${meeting.id}:${change}:${meeting.updatedAt.getTime()}`,
        email: true,
      },
      db,
    );
  }
}
