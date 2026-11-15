import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { WorkspaceAccessModule } from '@common/workspace/workspace-access.module';
import { FeedbackModule } from '@modules/feedback/feedback.module';
import { DashboardController } from './dashboard.controller';
import { ProjectProgressController } from './project-progress.controller';
import { DashboardService } from './dashboard.service';
import { ProjectMetricsService } from './progress/project-metrics.service';

@Module({
  imports: [PrismaModule, WorkspaceAccessModule, FeedbackModule],
  controllers: [DashboardController, ProjectProgressController],
  providers: [DashboardService, ProjectMetricsService],
  exports: [DashboardService, ProjectMetricsService],
})
export class DashboardModule {}
