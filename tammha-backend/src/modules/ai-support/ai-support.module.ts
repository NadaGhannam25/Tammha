import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { WorkspaceAccessModule } from '@common/workspace/workspace-access.module';
import { DashboardModule } from '@modules/dashboard/dashboard.module';
import { DocumentsModule } from '@modules/documents/documents.module';
import { NotificationsModule } from '@modules/notifications/notifications.module';
import { TasksModule } from '@modules/tasks/tasks.module';
import { StorageQuotaModule } from '@modules/storage/storage-quota.module';
import { AISupportController } from './ai-support.controller';
import { AISupportService } from './ai-support.service';
import { ProjectContextService } from './context/project-context.service';
import { HandbookService } from './handbook/handbook.service';
import { HandbookAdminController } from './handbook/handbook-admin.controller';
import { ProjectHandbookService } from './handbook/project-handbook.service';
import { ProjectHandbookController } from './handbook/project-handbook.controller';
import { AiConversationsService } from './conversations/ai-conversations.service';
import { AiConversationsController } from './conversations/ai-conversations.controller';
import { AiTaskSuggestionsService } from './apply/ai-task-suggestions.service';
import { AiTaskSuggestionsController } from './apply/ai-task-suggestions.controller';
import { HandbookLibraryService } from './library/handbook-library.service';
import { UniversityHandbooksController } from './library/university-handbooks.controller';
import { HandbookSummaryService } from './explanation/handbook-summary.service';

/**
 * AI Support (P13, extended in P16). All AI logic lives here; the provider is injected
 * through the AI_TEXT_PROVIDER port of the global IntegrationsModule (Gemini).
 *
 * Handbooks: each university's official handbook, the project's selection (a university
 * handbook or its own upload), the seven-topic AI summary and task extraction.
 * P16: project handbook (leader upload, versions, background processing), project-aware
 * context, side-chat conversations, and the leader-only Apply AI Task Suggestions
 * (the only path from AI output to real tasks, always an explicit user action).
 */
@Module({
  imports: [
    PrismaModule,
    WorkspaceAccessModule,
    DashboardModule,
    DocumentsModule,
    NotificationsModule,
    TasksModule,
    StorageQuotaModule,
  ],
  controllers: [
    AISupportController,
    HandbookAdminController,
    ProjectHandbookController,
    AiConversationsController,
    AiTaskSuggestionsController,
    UniversityHandbooksController,
  ],
  providers: [
    AISupportService,
    ProjectContextService,
    HandbookService,
    ProjectHandbookService,
    AiConversationsService,
    AiTaskSuggestionsService,
    HandbookLibraryService,
    HandbookSummaryService,
  ],
  exports: [
    AISupportService,
    HandbookService,
    HandbookLibraryService,
    ProjectHandbookService,
  ],
})
export class AISupportModule {}
