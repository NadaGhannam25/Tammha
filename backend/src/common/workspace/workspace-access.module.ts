import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { WorkspaceAccessService } from './workspace-access.service';

@Module({
  imports: [PrismaModule],
  providers: [WorkspaceAccessService],
  exports: [WorkspaceAccessService],
})
export class WorkspaceAccessModule {}
