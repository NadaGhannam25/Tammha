import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { SupervisionRequestsController } from './supervision/supervision-requests.controller';
import { SupervisionRequestsService } from './supervision/supervision-requests.service';
import { PrismaModule } from '@/prisma/prisma.module';
import { WorkspaceAccessModule } from '@common/workspace/workspace-access.module';
import { TeamsModule } from '@modules/teams/teams.module';
import { NotificationsModule } from '@modules/notifications/notifications.module';
import { DashboardModule } from '@modules/dashboard/dashboard.module';
import { ProjectStatusController } from './status/project-status.controller';
import { ProjectStatusService } from './status/project-status.service';
import { ProjectSetupReadinessService } from './setup/project-setup-readiness.service';

@Module({
  imports: [
    PrismaModule,
    WorkspaceAccessModule,
    TeamsModule,
    NotificationsModule,
    DashboardModule,
  ],
  controllers: [
    ProjectsController,
    SupervisionRequestsController,
    ProjectStatusController,
  ],
  providers: [
    ProjectsService,
    SupervisionRequestsService,
    ProjectStatusService,
    ProjectSetupReadinessService,
  ],
  exports: [
    ProjectsService,
    SupervisionRequestsService,
    ProjectSetupReadinessService,
  ],
})
export class ProjectsModule {}
