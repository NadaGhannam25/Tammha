import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MeetingStatus, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuthUser } from '@common/types/auth-user.type';
import { WorkspaceAccessService } from '@common/workspace/workspace-access.service';
import { PUBLIC_USER_SELECT } from '@common/workspace/user-select';
import {
  MeetingNotesViewDto,
  SharedMeetingNoteDto,
  UpsertMeetingNotesDto,
} from './dto/meeting-notes.dto';

const err = (code: string, message: string) => ({ code, message });

const NOTES_SELECT = {
  id: true,
  meetingId: true,
  content: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: PUBLIC_USER_SELECT },
  updatedBy: { select: PUBLIC_USER_SELECT },
} satisfies Prisma.MeetingNotesSelect;

type NotesRow = Prisma.MeetingNotesGetPayload<{
  select: typeof NOTES_SELECT;
}>;

/**
 * Notes of a meeting, one per author (the people who can see the meeting: the students
 * of the project team and its supervisor).
 * - Everyone reads and writes only their own notes ("mine").
 * - The supervisor's notes are shared with the team: students read them ("shared"),
 *   but cannot edit them.
 * - A student's notes are private: nobody else (not even the supervisor) reads them.
 */
@Injectable()
export class MeetingNotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
  ) {}

  async get(user: AuthUser, meetingId: string): Promise<MeetingNotesViewDto> {
    const meeting = await this.meetingOrThrow(meetingId);
    await this.access.assertCanViewProject(user, meeting.projectId);
    const rows = await this.prisma.meetingNotes.findMany({
      where: { meetingId },
      select: NOTES_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    return this.toView(meeting.id, user, rows);
  }

  async upsert(
    user: AuthUser,
    meetingId: string,
    dto: UpsertMeetingNotesDto,
  ): Promise<MeetingNotesViewDto> {
    const meeting = await this.meetingOrThrow(meetingId);
    await this.access.assertCanViewProject(user, meeting.projectId);
    if (meeting.cancelledAt || meeting.status === MeetingStatus.CANCELLED) {
      throw new ConflictException(
        err(
          'MEETING_CANCELLED',
          'Notes cannot be written for a cancelled meeting',
        ),
      );
    }
    const content = dto.content.replace(/\r\n/g, '\n').trim();
    if (!content) {
      throw new BadRequestException(
        err('MEETING_NOTES_EMPTY', 'Write the meeting notes first'),
      );
    }
    await this.prisma.meetingNotes.upsert({
      where: { meetingId_createdById: { meetingId, createdById: user.id } },
      create: {
        meetingId,
        content,
        createdById: user.id,
        updatedById: user.id,
      },
      update: { content, updatedById: user.id },
      select: { id: true },
    });
    return this.get(user, meetingId);
  }

  private async meetingOrThrow(meetingId: string) {
    const meeting = await this.prisma.meeting.findUnique({
      where: { id: meetingId },
      select: { id: true, projectId: true, status: true, cancelledAt: true },
    });
    if (!meeting) {
      throw new NotFoundException(
        err('MEETING_NOT_FOUND', 'Meeting not found'),
      );
    }
    return meeting;
  }

  private toView(
    meetingId: string,
    user: AuthUser,
    rows: NotesRow[],
  ): MeetingNotesViewDto {
    const mine = rows.find((r) => r.createdById === user.id) ?? null;
    const shared: SharedMeetingNoteDto[] = rows
      .filter(
        (r) =>
          r.createdById !== user.id &&
          r.createdBy?.role === UserRole.SUPERVISOR,
      )
      .map((r) => ({
        content: r.content,
        author: r.createdBy,
        updatedAt: r.updatedAt,
      }));
    return {
      meetingId,
      exists: !!mine,
      content: mine?.content ?? '',
      createdBy: mine?.createdBy ?? null,
      updatedBy: mine?.updatedBy ?? null,
      createdAt: mine?.createdAt ?? null,
      updatedAt: mine?.updatedAt ?? null,
      edited: !!mine && mine.updatedAt.getTime() > mine.createdAt.getTime(),
      visibility:
        user.role === UserRole.SUPERVISOR ? 'SHARED_WITH_TEAM' : 'PRIVATE',
      shared,
    };
  }
}
