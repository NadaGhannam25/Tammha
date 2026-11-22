import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { WorkspaceAccessModule } from '@common/workspace/workspace-access.module';
import { AuthModule } from '@modules/auth/auth.module';
import { DocumentsModule } from '@modules/documents/documents.module';
import { ProjectDeletionController } from './project-deletion.controller';
import { ProjectDeletionService } from './project-deletion.service';

/** Deleting a whole project by its owner (e-mailed code), with its stored files. */
@Module({
  imports: [PrismaModule, WorkspaceAccessModule, AuthModule, DocumentsModule],
  controllers: [ProjectDeletionController],
  providers: [ProjectDeletionService],
})
export class ProjectDeletionModule {}
