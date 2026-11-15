import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { WorkspaceAccessModule } from '@common/workspace/workspace-access.module';
import { NotificationsModule } from '@modules/notifications/notifications.module';
import { MeetingsController } from './meetings.controller';
import { MeetingsService } from './meetings.service';
import { MeetingNotesService } from './meeting-notes.service';

/** Meetings + LiveKit join tokens (MEETING_VIDEO_PROVIDER comes from the global IntegrationsModule). */
@Module({
  imports: [PrismaModule, WorkspaceAccessModule, NotificationsModule],
  controllers: [MeetingsController],
  providers: [MeetingsService, MeetingNotesService],
  exports: [MeetingsService],
})
export class MeetingsModule {}
