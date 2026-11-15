import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { WorkspaceAccessModule } from '@common/workspace/workspace-access.module';
import { NotificationsModule } from '@modules/notifications/notifications.module';
import { StorageQuotaModule } from '@modules/storage/storage-quota.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { SupabaseStorageService } from './supabase-storage.service';
import { StorageDeletionService } from '@modules/storage/storage-deletion.service';

@Module({
  imports: [
    PrismaModule,
    WorkspaceAccessModule,
    NotificationsModule,
    StorageQuotaModule,
  ],
  controllers: [DocumentsController],
  // StorageDeletionService lives here because it needs SupabaseStorageService
  providers: [DocumentsService, SupabaseStorageService, StorageDeletionService],
  exports: [DocumentsService, SupabaseStorageService, StorageDeletionService],
})
export class DocumentsModule {}
