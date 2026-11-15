import { Module } from '@nestjs/common';
import { TeamsController } from './teams.controller';
import { TeamsService } from './teams.service';
import { PrismaModule } from '@/prisma/prisma.module';
import { WorkspaceAccessModule } from '@common/workspace/workspace-access.module';
import { NotificationsModule } from '@modules/notifications/notifications.module';
import { TeamInvitationsController } from './team-invitations.controller';
import { TeamInvitationsService } from './team-invitations.service';

@Module({
  imports: [PrismaModule, WorkspaceAccessModule, NotificationsModule],
  controllers: [TeamsController, TeamInvitationsController],
  providers: [TeamsService, TeamInvitationsService],
  exports: [TeamsService, TeamInvitationsService],
})
export class TeamsModule {}
