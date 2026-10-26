import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { validateEnv } from './config/env.validation';
import { SecurityModule } from './common/security/security.module';

// Feature Modules
import { AuthModule } from './modules/auth/auth.module';
import { UniversitiesModule } from './modules/universities/universities.module';
import { UsersModule } from './modules/users/users.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { TeamsModule } from './modules/teams/teams.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { MilestonesModule } from './modules/milestones/milestones.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { FeedbackModule } from './modules/feedback/feedback.module';
import { MeetingsModule } from './modules/meetings/meetings.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { AISupportModule } from './modules/ai-support/ai-support.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { NotificationsSchedulerModule } from './modules/notifications/notifications-scheduler.module';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      cache: true,
      validate: validateEnv,
    }),

    // Rate limiting (P14)
    SecurityModule,

    // Database
    PrismaModule,

    // External integrations: configuration + ports (P10)
    IntegrationsModule,

    // Feature Modules
    AuthModule,
    UniversitiesModule,
    UsersModule,
    ProjectsModule,
    TeamsModule,
    TasksModule,
    MilestonesModule,
    DocumentsModule,
    FeedbackModule,
    MeetingsModule,
    NotificationsModule,
    // Deadline reminders + email dispatch jobs (P11)
    NotificationsSchedulerModule,
    DashboardModule,
    AISupportModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
