import { Module } from '@nestjs/common';
import { StudentsController, UsersController } from './users.controller';
import { AccountService } from './account.service';
import { UsersService } from './users.service';
import { PrismaModule } from '@/prisma/prisma.module';
import { StorageQuotaModule } from '@modules/storage/storage-quota.module';

@Module({
  imports: [PrismaModule, StorageQuotaModule],
  controllers: [UsersController, StudentsController],
  providers: [UsersService, AccountService],
  exports: [UsersService],
})
export class UsersModule {}
