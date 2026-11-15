import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { UniversitiesController } from './universities.controller';

@Module({
  imports: [PrismaModule],
  controllers: [UniversitiesController],
})
export class UniversitiesModule {}
