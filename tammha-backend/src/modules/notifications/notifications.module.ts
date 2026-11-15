import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { EmailOutboxService } from './email/email-outbox.service';
import { TaskRemindersService } from './reminders/task-reminders.service';
import { MeetingNotificationsService } from './meeting-notifications.service';

@Module({
  imports: [PrismaModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    EmailOutboxService,
    TaskRemindersService,
    MeetingNotificationsService,
  ],
  exports: [
    NotificationsService,
    EmailOutboxService,
    TaskRemindersService,
    MeetingNotificationsService,
  ],
})
export class NotificationsModule {}
