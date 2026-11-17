import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MeetingStatus, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuthUser } from '@common/types/auth-user.type';
import { PUBLIC_USER_SELECT } from '@common/workspace/user-select';
import { WorkspaceAccessService } from '@common/workspace/workspace-access.service';
import { toPageArgs, toPageMeta } from '@common/dtos/pagination.dto';
import {
  MEETING_VIDEO_PROVIDER,
  MeetingVideoProvider,
  newMeetingRoomName,
} from '@/integrations/meetings/meeting-video.provider';
import { integrationDisabled } from '@/integrations/integration-errors';
import {
  MeetingChange,
  MeetingNotificationsService,
} from '@modules/notifications/meeting-notifications.service';
import {
  MEETING_LIMITS,
  MeetingSettings,
  readMeetingSettings,
} from './meetings.config';
import {
  CancelMeetingDto,
  CreateMeetingDto,
  MeetingListQueryDto,
  MeetingPageDto,
  MeetingState,
  MeetingTokenDto,
  MeetingViewDto,
  UpcomingMeetingsQueryDto,
  UpdateMeetingDto,
} from './dto/meeting.dto';

type Db = PrismaService | Prisma.TransactionClient;

const MINUTE = 60_000;
/** Small allowance for clock differences when checking "in the future". */
const CLOCK_SKEW_MS = MINUTE;
/** Upcoming list: meetings considered at most (one long meeting can be ongoing). */
const UPCOMING_SCAN_LIMIT = 200;

const MEETING_SELECT = {
  id: true,
  projectId: true,
  title: true,
  description: true,
  scheduledAt: true,
  duration: true,
  location: true,
  status: true,
  liveKitRoomName: true,
  cancelledAt: true,
  cancellationReason: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: PUBLIC_USER_SELECT },
  notes: {
    select: {
      createdById: true,
      updatedAt: true,
      createdBy: { select: { role: true } },
    },
  },
  attendees: {
    select: {
      userId: true,
      status: true,
      joinedAt: true,
      user: { select: PUBLIC_USER_SELECT },
    },
    orderBy: { userId: 'asc' },
  },
} satisfies Prisma.MeetingSelect;

type MeetingRow = Prisma.MeetingGetPayload<{ select: typeof MEETING_SELECT }>;

/** Business error body: { code, message, details? } (details reach the client, 4xx only). */
const err = (code: string, message: string, details?: object) => ({
  code,
  message,
  ...(details && { details }),
});

/**
 * Meetings of a graduation project, embedded with LiveKit.
 *
 * Access (checked against the CURRENT project membership on every request):
 *  - read / create: students of the project team and the project's supervisor
 *  - edit / cancel: the organiser or the project's supervisor
 *  - LiveKit token: a listed participant who is still a member of the project,
 *    inside the join window, meeting not cancelled
 * ADMIN and anyone else: 403. LIVEKIT_API_SECRET never leaves the LiveKit adapter.
 */
@Injectable()
export class MeetingsService {
  private readonly settings: MeetingSettings;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly meetingNotifications: MeetingNotificationsService,
    @Inject(MEETING_VIDEO_PROVIDER)
    private readonly video: MeetingVideoProvider,
    config: ConfigService,
  ) {
    this.settings = readMeetingSettings({
      MEETING_JOIN_EARLY_MINUTES: config.get('MEETING_JOIN_EARLY_MINUTES'),
      MEETING_JOIN_GRACE_MINUTES: config.get('MEETING_JOIN_GRACE_MINUTES'),
    }).settings;
  }

  // ==========================================================
  // Create / update / cancel
  // ==========================================================

  async create(user: AuthUser, dto: CreateMeetingDto): Promise<MeetingViewDto> {
    const project = await this.access.assertCanViewProject(user, dto.projectId);
    const scheduledAt = this.futureDate(dto.scheduledAt);
    const members = await this.projectMemberIds(project.id, project.teamId);
    const participants = this.resolveParticipants(
      dto.participantIds,
      members,
      user.id,
    );

    const id = await this.prisma.$transaction(async (tx) => {
      const meeting = await tx.meeting.create({
        data: {
          projectId: project.id,
          createdById: user.id,
          title: dto.title,
          description: dto.description || null,
          scheduledAt,
          duration: dto.durationMinutes ?? MEETING_LIMITS.DEFAULT_DURATION,
          location: dto.location || null,
          status: MeetingStatus.SCHEDULED,
          liveKitRoomName: newMeetingRoomName(),
        },
        select: { id: true },
      });
      await tx.meetingAttendee.createMany({
        data: participants.map((userId) => ({ meetingId: meeting.id, userId })),
      });
      await this.notify(meeting.id, 'SCHEDULED', user.id, tx);
      return meeting.id;
    });
    return this.toView(await this.load(id), user, true);
  }

  async update(
    user: AuthUser,
    meetingId: string,
    dto: UpdateMeetingDto,
  ): Promise<MeetingViewDto> {
    const current = await this.load(meetingId);
    const project = await this.assertCanManage(user, current);
    this.assertEditable(current);

    const data: Prisma.MeetingUpdateManyMutationInput = {};
    if (dto.title !== undefined && dto.title !== current.title)
      data.title = dto.title;
    if (dto.description !== undefined) {
      const next = dto.description || null;
      if (next !== current.description) data.description = next;
    }
    if (dto.location !== undefined) {
      const next = dto.location || null;
      if (next !== current.location) data.location = next;
    }
    if (
      dto.durationMinutes !== undefined &&
      dto.durationMinutes !== current.duration
    ) {
      data.duration = dto.durationMinutes;
    }
    if (dto.scheduledAt !== undefined) {
      const next = this.futureDate(dto.scheduledAt);
      if (next.getTime() !== current.scheduledAt.getTime())
        data.scheduledAt = next;
    }

    let added: string[] = [];
    let removed: string[] = [];
    if (dto.participantIds !== undefined) {
      const members = await this.projectMemberIds(project.id, project.teamId);
      const next = this.resolveParticipants(
        dto.participantIds,
        members,
        current.createdById,
      );
      const before = current.attendees.map((a) => a.userId);
      added = next.filter((id) => !before.includes(id));
      removed = before.filter((id) => !next.includes(id));
    }

    const changed =
      Object.keys(data).length > 0 || added.length > 0 || removed.length > 0;
    if (!changed) return this.toView(current, user);

    // Participants are told about changes they can see: time, length, place, title, people.
    const notifyChange =
      'title' in data ||
      'scheduledAt' in data ||
      'duration' in data ||
      'location' in data ||
      added.length > 0;

    await this.prisma.$transaction(async (tx) => {
      // compare-and-set: a meeting cancelled meanwhile is not modified
      const { count } = await tx.meeting.updateMany({
        where: { id: meetingId, cancelledAt: null },
        data: { ...data, updatedAt: new Date() },
      });
      if (count === 0) throw cancelledError();
      if (removed.length > 0) {
        await tx.meetingAttendee.deleteMany({
          where: { meetingId, userId: { in: removed } },
        });
      }
      if (added.length > 0) {
        await tx.meetingAttendee.createMany({
          data: added.map((userId) => ({ meetingId, userId })),
          skipDuplicates: true,
        });
      }
      if (notifyChange) await this.notify(meetingId, 'UPDATED', user.id, tx);
    });
    return this.toView(await this.load(meetingId), user);
  }

  async cancel(
    user: AuthUser,
    meetingId: string,
    dto: CancelMeetingDto,
  ): Promise<MeetingViewDto> {
    const current = await this.load(meetingId);
    await this.assertCanManage(user, current);
    this.assertEditable(current);

    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const { count } = await tx.meeting.updateMany({
        where: { id: meetingId, cancelledAt: null },
        data: {
          status: MeetingStatus.CANCELLED,
          cancelledAt: now,
          cancellationReason: dto.reason || null,
          updatedAt: now,
        },
      });
      if (count === 0) throw cancelledError();
      await this.notify(meetingId, 'CANCELLED', user.id, tx);
    });
    return this.toView(await this.load(meetingId), user);
  }

  /**
   * "End meeting for everyone" (organiser or project supervisor): the meeting is marked
   * COMPLETED, nobody can join again, and the video room is closed (everyone is
   * disconnected).
   */
  async end(user: AuthUser, meetingId: string): Promise<MeetingViewDto> {
    const current = await this.load(meetingId);
    await this.assertCanManage(user, current);
    if (current.cancelledAt || current.status === MeetingStatus.CANCELLED) {
      throw cancelledError();
    }
    if (current.status !== MeetingStatus.COMPLETED) {
      await this.prisma.meeting.update({
        where: { id: meetingId },
        data: { status: MeetingStatus.COMPLETED, updatedAt: new Date() },
      });
    }
    if (current.liveKitRoomName && this.video.closeRoom) {
      await this.video.closeRoom(current.liveKitRoomName);
    }
    return this.toView(await this.load(meetingId), user);
  }

  // ==========================================================
  // Read
  // ==========================================================

  async findOne(user: AuthUser, meetingId: string): Promise<MeetingViewDto> {
    const meeting = await this.load(meetingId);
    await this.access.assertCanViewProject(user, meeting.projectId);
    return this.toView(meeting, user);
  }

  async findMany(
    user: AuthUser,
    query: MeetingListQueryDto,
  ): Promise<MeetingPageDto> {
    const where = await this.scope(user, query.projectId, query.mine);
    if (!query.includeCancelled) where.cancelledAt = null;
    if (query.from || query.to) {
      where.scheduledAt = {
        ...(query.from && { gte: new Date(query.from) }),
        ...(query.to && { lte: new Date(query.to) }),
      };
    }
    const { page, limit, skip, take } = toPageArgs(query);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.meeting.count({ where }),
      this.prisma.meeting.findMany({
        where,
        select: MEETING_SELECT,
        orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
        skip,
        take,
      }),
    ]);
    return {
      items: rows.map((r) => this.toView(r, user)),
      meta: toPageMeta(page, limit, total),
    };
  }

  /** Not cancelled, not yet ended (ongoing included), starting within `days`. Soonest first. */
  async findUpcoming(
    user: AuthUser,
    query: UpcomingMeetingsQueryDto,
  ): Promise<MeetingPageDto> {
    const now = Date.now();
    const where = await this.scope(user, query.projectId, query.mine);
    where.cancelledAt = null;
    where.scheduledAt = {
      // the longest meeting that could still be running started this long ago
      gte: new Date(now - MEETING_LIMITS.MAX_DURATION * MINUTE),
      lte: new Date(now + (query.days ?? 30) * 24 * 60 * MINUTE),
    };
    const rows = await this.prisma.meeting.findMany({
      where,
      select: MEETING_SELECT,
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
      take: UPCOMING_SCAN_LIMIT,
    });
    const upcoming = rows.filter(
      (r) => r.scheduledAt.getTime() + r.duration * MINUTE > now,
    );
    const { page, limit, skip, take } = toPageArgs(query);
    return {
      items: upcoming.slice(skip, skip + take).map((r) => this.toView(r, user)),
      meta: toPageMeta(page, limit, upcoming.length),
    };
  }

  // ==========================================================
  // LiveKit join token
  // ==========================================================

  async createJoinToken(
    user: AuthUser,
    meetingId: string,
  ): Promise<MeetingTokenDto> {
    const meeting = await this.load(meetingId);
    // 1. current project membership (re-checked on every request)
    await this.access.assertCanViewProject(user, meeting.projectId);
    // 2. listed participant
    if (!meeting.attendees.some((a) => a.userId === user.id)) {
      throw new ForbiddenException(
        err(
          'MEETING_NOT_PARTICIPANT',
          'You are not a participant of this meeting',
        ),
      );
    }
    // 3. meeting state and join window
    if (meeting.cancelledAt || meeting.status === MeetingStatus.CANCELLED) {
      throw cancelledError();
    }
    const window = this.joinWindow(meeting);
    const now = Date.now();
    if (now < window.opensAt.getTime()) {
      throw new ConflictException(
        err('MEETING_NOT_OPEN_YET', 'The meeting is not open yet', {
          opensAt: window.opensAt,
        }),
      );
    }
    if (
      now > window.closesAt.getTime() ||
      meeting.status === MeetingStatus.COMPLETED
    ) {
      throw new ConflictException(
        err('MEETING_ENDED', 'This meeting has ended'),
      );
    }
    // 4. LiveKit configured on this server
    if (!this.video.isEnabled()) throw integrationDisabled('livekit');

    const roomName =
      meeting.liveKitRoomName ?? (await this.assignRoomName(meeting.id));
    const me = meeting.attendees.find((a) => a.userId === user.id)!.user;
    const displayName =
      [me.firstName, me.lastName].filter(Boolean).join(' ').trim() ||
      'Participant';
    const ttlSeconds = Math.max(
      60,
      Math.floor((window.closesAt.getTime() - now) / 1000),
    );

    const credentials = await this.video.createJoinCredentials({
      roomName,
      identity: user.id,
      displayName,
      canPublish: true,
      ttlSeconds: Math.min(ttlSeconds, 24 * 60 * 60),
      metadata: JSON.stringify({
        meetingId: meeting.id,
        projectId: meeting.projectId,
        role: user.role,
      }),
    });

    // first join time (best effort, no effect on the token)
    await this.prisma.meetingAttendee.updateMany({
      where: { meetingId, userId: user.id, joinedAt: null },
      data: { joinedAt: new Date() },
    });

    return {
      serverUrl: credentials.serverUrl,
      token: credentials.token,
      // the meeting window limits the token even when LIVEKIT_TOKEN_TTL_SECONDS is longer
      expiresAt: credentials.expiresAt,
      roomName,
      identity: user.id,
      displayName,
      meetingId: meeting.id,
    };
  }

  // ==========================================================
  // Internals
  // ==========================================================

  private async load(meetingId: string, db: Db = this.prisma) {
    const meeting = await db.meeting.findUnique({
      where: { id: meetingId },
      select: MEETING_SELECT,
    });
    if (!meeting) {
      throw new NotFoundException(
        err('MEETING_NOT_FOUND', 'Meeting not found'),
      );
    }
    return meeting;
  }

  /** The organiser or the project's supervisor, and still a member of the project. */
  private async assertCanManage(user: AuthUser, meeting: MeetingRow) {
    const project = await this.access.assertCanViewProject(
      user,
      meeting.projectId,
    );
    const isSupervisor =
      user.role === UserRole.SUPERVISOR &&
      (await this.access.isSupervisorOfProject(user.id, project.id));
    if (meeting.createdById !== user.id && !isSupervisor) {
      throw new ForbiddenException(
        err(
          'MEETING_MANAGE_NOT_ALLOWED',
          'Only the organiser or the project supervisor can change this meeting',
        ),
      );
    }
    return project;
  }

  private assertEditable(meeting: MeetingRow) {
    if (meeting.cancelledAt || meeting.status === MeetingStatus.CANCELLED) {
      throw cancelledError();
    }
    if (endOf(meeting) <= Date.now()) {
      throw new ConflictException(
        err('MEETING_ENDED', 'This meeting has ended and cannot be changed'),
      );
    }
  }

  /** Students of the team + the project's supervisor(s). */
  private async projectMemberIds(projectId: string, teamId: string) {
    const [students, supervisors] = await Promise.all([
      this.access.getTeamStudentIds(teamId),
      this.access.getProjectSupervisorIds(projectId),
    ]);
    return new Set([...students, ...supervisors]);
  }

  private resolveParticipants(
    requested: string[] | undefined,
    members: Set<string>,
    organiserId: string,
  ): string[] {
    if (!requested) return [...new Set([...members, organiserId])];
    const outsiders = requested.filter((id) => !members.has(id));
    if (outsiders.length > 0) {
      throw new BadRequestException(
        err(
          'MEETING_PARTICIPANT_NOT_IN_PROJECT',
          'Participants must be students of the project team or its supervisor',
          { userIds: outsiders },
        ),
      );
    }
    return [...new Set([organiserId, ...requested])];
  }

  private futureDate(iso: string): Date {
    const date = new Date(iso);
    if (
      Number.isNaN(date.getTime()) ||
      date.getTime() < Date.now() - CLOCK_SKEW_MS
    ) {
      throw new BadRequestException(
        err('MEETING_IN_PAST', 'scheduledAt must be in the future'),
      );
    }
    return date;
  }

  /** Readable projects of the user (students: own; supervisors: supervised). */
  private async scope(
    user: AuthUser,
    projectId: string | undefined,
    mine: boolean | undefined,
  ): Promise<Prisma.MeetingWhereInput> {
    // ADMIN never reaches this point (role guard); others see only their projects
    const projectIds = projectId
      ? [(await this.access.assertCanViewProject(user, projectId)).id]
      : await this.access.getReadableProjectIds(user);
    return {
      projectId: { in: projectIds },
      ...(mine && { attendees: { some: { userId: user.id } } }),
    };
  }

  private async assignRoomName(meetingId: string): Promise<string> {
    // meetings created before P12 have no room yet: assign one atomically
    await this.prisma.meeting.updateMany({
      where: { id: meetingId, liveKitRoomName: null },
      data: { liveKitRoomName: newMeetingRoomName() },
    });
    const row = await this.prisma.meeting.findUniqueOrThrow({
      where: { id: meetingId },
      select: { liveKitRoomName: true },
    });
    return row.liveKitRoomName!;
  }

  private notify(
    meetingId: string,
    change: MeetingChange,
    actorId: string,
    tx: Prisma.TransactionClient,
  ) {
    return this.meetingNotifications.notifyMeetingChange(
      meetingId,
      change,
      actorId,
      tx,
    );
  }

  private joinWindow(meeting: MeetingRow) {
    const start = meeting.scheduledAt.getTime();
    // the room can be joined as soon as the meeting is scheduled (or JOIN_EARLY minutes
    // before the start for older rows without a creation time)
    const opensAt = new Date(
      Math.min(
        start - this.settings.joinEarlyMinutes * MINUTE,
        meeting.createdAt ? meeting.createdAt.getTime() : Infinity,
      ),
    );
    const closesAt = new Date(
      endOf(meeting) + this.settings.joinGraceMinutes * MINUTE,
    );
    const now = Date.now();
    const cancelled =
      !!meeting.cancelledAt || meeting.status === MeetingStatus.COMPLETED;
    return {
      opensAt,
      closesAt,
      isOpen:
        !cancelled && now >= opensAt.getTime() && now <= closesAt.getTime(),
    };
  }

  private toView(
    meeting: MeetingRow,
    user: AuthUser,
    canManage?: boolean,
  ): MeetingViewDto {
    const now = Date.now();
    const status: MeetingState =
      meeting.cancelledAt || meeting.status === MeetingStatus.CANCELLED
        ? 'CANCELLED'
        : meeting.status === MeetingStatus.COMPLETED
          ? 'COMPLETED'
          : now < meeting.scheduledAt.getTime()
            ? 'SCHEDULED'
            : now < endOf(meeting)
              ? 'ONGOING'
              : 'COMPLETED';
    return {
      id: meeting.id,
      projectId: meeting.projectId,
      title: meeting.title,
      description: meeting.description,
      scheduledAt: meeting.scheduledAt,
      durationMinutes: meeting.duration,
      endsAt: new Date(endOf(meeting)),
      location: meeting.location,
      status,
      cancelledAt: meeting.cancelledAt,
      cancellationReason: meeting.cancellationReason,
      roomName: meeting.liveKitRoomName,
      createdBy: meeting.createdBy,
      participants: meeting.attendees.map((a) => ({
        user: a.user,
        attendance: a.status,
        joinedAt: a.joinedAt,
      })),
      isParticipant: meeting.attendees.some((a) => a.userId === user.id),
      canManage:
        canManage ??
        (meeting.createdById === user.id || user.role === UserRole.SUPERVISOR),
      join: this.joinWindow(meeting),
      // notes this user can read: their own and the supervisor's (shared with the team)
      ...visibleNotes(meeting.notes, user.id),
      createdAt: meeting.createdAt,
      updatedAt: meeting.updatedAt,
    };
  }
}

function visibleNotes(
  notes: {
    createdById: string | null;
    updatedAt: Date;
    createdBy: { role: UserRole } | null;
  }[],
  userId: string,
) {
  const seen = notes.filter(
    (n) =>
      n.createdById === userId || n.createdBy?.role === UserRole.SUPERVISOR,
  );
  const last = seen.reduce<Date | null>(
    (max, n) => (!max || n.updatedAt > max ? n.updatedAt : max),
    null,
  );
  return { hasNotes: seen.length > 0, notesUpdatedAt: last };
}

function endOf(meeting: { scheduledAt: Date; duration: number }): number {
  return meeting.scheduledAt.getTime() + meeting.duration * MINUTE;
}

function cancelledError() {
  return new ConflictException(
    err('MEETING_CANCELLED', 'This meeting has been cancelled'),
  );
}
