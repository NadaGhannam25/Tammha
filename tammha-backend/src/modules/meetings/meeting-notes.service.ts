import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MeetingStatus, Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuthUser } from '@common/types/auth-user.type';
import { WorkspaceAccessService } from '@common/workspace/workspace-access.service';
import { PUBLIC_USER_SELECT } from '@common/workspace/user-select';
import {
  MeetingNotesViewDto,
  UpsertMeetingNotesDto,
} from './dto/meeting-notes.dto';

const err = (code: string, message: string) => ({ code, message });

const NOTES_SELECT = {
  id: true,
  meetingId: true,
  content: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: PUBLIC_USER_SELECT },
  updatedBy: { select: PUBLIC_USER_SELECT },
} satisfies Prisma.MeetingNotesSelect;

/**
 * Notes of a meeting (the existing MeetingNotes model: one note per meeting).
 * Read and write: the students of the project team and the project's supervisor (the
 * same people who can see the meeting). Writing creates the note the first time and
 * updates it afterwards; the author and the last editor are recorded.
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
    const row = await this.prisma.meetingNotes.findUnique({
      where: { meetingId },
      select: NOTES_SELECT,
    });
    return this.toView(meeting.id, row);
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
    const row = await this.prisma.meetingNotes.upsert({
      where: { meetingId },
      create: {
        meetingId,
        content,
        createdById: user.id,
        updatedById: user.id,
      },
      update: { content, updatedById: user.id },
      select: NOTES_SELECT,
    });
    return this.toView(meeting.id, row);
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
    row: Prisma.MeetingNotesGetPayload<{ select: typeof NOTES_SELECT }> | null,
  ): MeetingNotesViewDto {
    return {
      meetingId,
      exists: !!row,
      content: row?.content ?? '',
      createdBy: row?.createdBy ?? null,
      updatedBy: row?.updatedBy ?? null,
      createdAt: row?.createdAt ?? null,
      updatedAt: row?.updatedAt ?? null,
      edited: !!row && row.updatedAt.getTime() > row.createdAt.getTime(),
    };
  }
}
