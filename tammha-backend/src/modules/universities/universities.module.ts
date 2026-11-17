import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { UniversitiesController } from './universities.controller';
import { UniversitiesCatalogSeeder } from './universities-catalog.seeder';

@Module({
  imports: [PrismaModule],
  controllers: [UniversitiesController],
  providers: [UniversitiesCatalogSeeder],
})
export class UniversitiesModule {}
