import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { WorkspaceAccessModule } from '@common/workspace/workspace-access.module';
import { NotificationsModule } from '@modules/notifications/notifications.module';
import {
  FeedbackController,
  TaskFeedbackController,
} from './feedback.controller';
import { SubmissionStatusController } from './submission-status.controller';
import { FeedbackService } from './feedback.service';

@Module({
  imports: [PrismaModule, WorkspaceAccessModule, NotificationsModule],
  controllers: [
    FeedbackController,
    TaskFeedbackController,
    SubmissionStatusController,
  ],
  providers: [FeedbackService],
  exports: [FeedbackService],
})
export class FeedbackModule {}
