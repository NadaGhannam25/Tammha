import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TaskCommentsService } from './task-comments.service';
import { TaskCommentsController } from './task-comments.controller';
import { PrismaModule } from '@/prisma/prisma.module';
import { WorkspaceAccessModule } from '@common/workspace/workspace-access.module';
import { NotificationsModule } from '@modules/notifications/notifications.module';

@Module({
  imports: [PrismaModule, WorkspaceAccessModule, NotificationsModule],
  controllers: [TasksController, TaskCommentsController],
  providers: [TasksService, TaskCommentsService],
  exports: [TasksService],
})
export class TasksModule {}
