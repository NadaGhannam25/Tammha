import { Module } from '@nestjs/common';
import { MilestonesController } from './milestones.controller';
import { MilestonesService } from './milestones.service';
import { PrismaModule } from '@/prisma/prisma.module';
import { WorkspaceAccessModule } from '@common/workspace/workspace-access.module';

@Module({
  imports: [PrismaModule, WorkspaceAccessModule],
  controllers: [MilestonesController],
  providers: [MilestonesService],
  exports: [MilestonesService],
})
export class MilestonesModule {}
