import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { StorageQuotaService } from './storage-quota.service';

/** Student storage quota (one per student, shared across projects). Used by every upload path. */
@Module({
  imports: [PrismaModule],
  providers: [StorageQuotaService],
  exports: [StorageQuotaService],
})
export class StorageQuotaModule {}
