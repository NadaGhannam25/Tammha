import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { MULTIPART_FIELD_LIMITS } from '@common/security/multipart-limits';
import { StrictRateLimit } from '@common/security/rate-limit.decorator';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '@modules/auth/guards/roles.guard';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { AuthUser } from '@common/types/auth-user.type';
import { UploadedDocumentFile } from '@modules/documents/document-files';
import { ProjectHandbookService } from './project-handbook.service';
import {
  HandbookFileUrlDto,
  ProjectHandbookStateDto,
  ProjectHandbookVersionDto,
  UploadProjectHandbookDto,
} from '../dto/handbook.dto';
import { HandbookSummaryService } from '../explanation/handbook-summary.service';
import {
  ExtractHandbookTasksDto,
  GenerateHandbookSummaryDto,
  HandbookSummaryQueryDto,
  HandbookSummaryViewDto,
  HandbookTasksResultDto,
} from '../explanation/handbook-summary.dto';
import { SelectUniversityHandbookDto } from '../library/library.dto';

/** Hard ceiling for multer; HANDBOOK_MAX_FILE_MB (default 20) is enforced by the service. */
const MULTER_CEILING_BYTES = 50 * 1024 * 1024;

@Controller('projects/:projectId/handbook')
@ApiTags('Project Handbook')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles([UserRole.STUDENT, UserRole.SUPERVISOR])
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
@ApiResponse({
  status: 403,
  description: 'PROJECT_ACCESS_DENIED (or NOT_TEAM_LEADER for uploads)',
})
@ApiResponse({ status: 404, description: 'PROJECT_NOT_FOUND' })
export class ProjectHandbookController {
  constructor(
    private readonly handbooks: ProjectHandbookService,
    private readonly handbookAi: HandbookSummaryService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Handbook state of the project: NONE / PROCESSING / READY / FAILED',
    description:
      'Project students and its supervisor. Shows the active version (used by the AI) and the latest ' +
      'upload. Metadata only: the extracted text is never returned.',
  })
  @ApiOkResponse({ type: ProjectHandbookStateDto })
  state(@CurrentUser() user: AuthUser, @Param('projectId') projectId: string) {
    return this.handbooks.state(user, projectId);
  }

  @Put()
  @Roles([UserRole.STUDENT])
  @StrictRateLimit()
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        ...MULTIPART_FIELD_LIMITS,
        fileSize: MULTER_CEILING_BYTES,
        files: 1,
      },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload or replace the project handbook (team leader only)',
    description:
      'Text-based PDF, max HANDBOOK_MAX_FILE_MB (default 20 MB). Each upload is a new version. Answers 202 ' +
      'with state PROCESSING; poll GET until READY or FAILED (a HANDBOOK_PROCESSED notification is also sent). ' +
      'When the new version fails, the previous READY version stays active. Does not use the AI quota.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        title: { type: 'string', minLength: 3, maxLength: 200 },
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiAcceptedResponse({ type: ProjectHandbookStateDto })
  @ApiResponse({
    status: 400,
    description:
      'Validation error, FILE_REQUIRED, FILE_EMPTY or HANDBOOK_NOT_PDF',
  })
  @ApiResponse({ status: 413, description: 'FILE_TOO_LARGE' })
  @ApiResponse({
    status: 409,
    description:
      "STORAGE_QUOTA_EXCEEDED — the PDF would exceed the uploader's storage quota (details: usedBytes, quotaBytes, remainingBytes, requestedBytes)",
  })
  @ApiResponse({ status: 503, description: 'STORAGE_ERROR' })
  upload(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Body() dto: UploadProjectHandbookDto,
    @UploadedFile() file: UploadedDocumentFile | undefined,
  ) {
    return this.handbooks.upload(user, projectId, { title: dto.title, file });
  }

  @Get('versions')
  @ApiOperation({ summary: 'All uploaded versions, newest first' })
  @ApiOkResponse({ type: [ProjectHandbookVersionDto] })
  versions(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
  ) {
    return this.handbooks.versions(user, projectId);
  }

  @Get('file')
  @ApiOperation({
    summary: 'Signed URL of the active handbook PDF (short-lived)',
  })
  @ApiOkResponse({ type: HandbookFileUrlDto })
  @ApiResponse({ status: 404, description: 'HANDBOOK_NOT_FOUND' })
  file(@CurrentUser() user: AuthUser, @Param('projectId') projectId: string) {
    return this.handbooks.fileUrl(user, projectId);
  }

  @Delete('versions/:handbookId')
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary: 'Delete an old or failed handbook version (team leader)',
    description:
      'Removes the version and its stored PDF permanently. The space is released only after ' +
      'Supabase Storage confirms the removal (`releasedBytes` > 0); if that fails, `releasedBytes` is 0, ' +
      '`storage.status` is PENDING_DELETION, the PDF keeps counting and the removal is retried automatically. ' +
      'The active version and a version still processing cannot be deleted.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        deleted: { type: 'boolean' },
        releasedBytes: { type: 'number' },
        storage: {
          type: 'object',
          description:
            'REMOVED = stored objects removed, space released. PENDING_DELETION = Supabase Storage ' +
            'could not remove them yet: they still count toward storage and are retried automatically.',
          properties: {
            status: { type: 'string', enum: ['REMOVED', 'PENDING_DELETION'] },
            pendingObjects: { type: 'number' },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'HANDBOOK_NOT_FOUND' })
  @ApiResponse({
    status: 409,
    description: 'HANDBOOK_ACTIVE_VERSION or HANDBOOK_PROCESSING',
  })
  deleteVersion(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('handbookId') handbookId: string,
  ) {
    return this.handbooks.deleteVersion(user, projectId, handbookId);
  }

  @Get('versions/:handbookId/file')
  @ApiOperation({ summary: 'Signed URL of one version of the handbook PDF' })
  @ApiOkResponse({ type: HandbookFileUrlDto })
  @ApiResponse({ status: 404, description: 'HANDBOOK_NOT_FOUND' })
  versionFile(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('handbookId') handbookId: string,
  ) {
    return this.handbooks.fileUrl(user, projectId, handbookId);
  }

  // ---------- university handbook selection ----------

  @Put('university-selection')
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary:
      "Use a university's official handbook for this project (team leader)",
    description:
      "Any university can be chosen: this never changes anyone's registered university. The project uses the " +
      "university's current official PDF (setup readiness, summary, task extraction and AI guidance). Uploaded " +
      'versions are kept; uploading a new PDF switches back to the upload.',
  })
  @ApiOkResponse({ type: ProjectHandbookStateDto })
  @ApiResponse({
    status: 404,
    description:
      'UNIVERSITY_NOT_IN_HANDBOOK_LIST or UNIVERSITY_HANDBOOK_NOT_AVAILABLE',
  })
  selectUniversity(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Body() dto: SelectUniversityHandbookDto,
  ) {
    return this.handbooks.selectUniversityHandbook(
      user,
      projectId,
      dto.universityKey,
    );
  }

  @Delete('university-selection')
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary:
      "Stop using the university handbook: use the project's own upload (team leader)",
  })
  @ApiOkResponse({ type: ProjectHandbookStateDto })
  clearUniversity(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
  ) {
    return this.handbooks.useUploadedHandbook(user, projectId);
  }

  // ---------- AI: fixed-topic summary of the selected handbook ----------

  @Get('summary')
  @ApiOperation({
    summary:
      "Seven-topic AI summary of the project's selected handbook (if generated)",
    description:
      'Topics (fixed ids, always in this order): OVERVIEW, REPORT_STRUCTURE, GRADING, SUBMISSION, PROPOSAL, ' +
      'WEEKLY_REPORTS, FINAL_DEFENSE. found=false means the handbook does not cover the topic.',
  })
  @ApiOkResponse({ type: HandbookSummaryViewDto })
  @ApiResponse({ status: 404, description: 'HANDBOOK_NOT_FOUND' })
  summary(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Query() query: HandbookSummaryQueryDto,
  ) {
    return this.handbookAi.getSummary(user, projectId, query.language ?? 'ar');
  }

  @Post('summary')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Summarise the project's selected handbook with AI (seven fixed topics)",
    description:
      'Project students and its supervisor. Returns the existing summary without an AI call unless ' +
      'regenerate=true; otherwise one AI request (AI limits). A malformed or failed AI answer is an error ' +
      'and is never stored or shown as a summary.',
  })
  @ApiOkResponse({ type: HandbookSummaryViewDto })
  @ApiResponse({ status: 404, description: 'HANDBOOK_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'HANDBOOK_NOT_READABLE' })
  @ApiResponse({ status: 429, description: 'AI_RATE_LIMITED' })
  @ApiResponse({
    status: 502,
    description: 'AI_INVALID_RESPONSE or AI_PROVIDER_ERROR',
  })
  @ApiResponse({
    status: 503,
    description: 'AI_PROVIDER_UNAVAILABLE / AI_DISABLED',
  })
  @ApiResponse({ status: 504, description: 'AI_PROVIDER_TIMEOUT' })
  generateSummary(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Body() dto: GenerateHandbookSummaryDto,
  ) {
    return this.handbookAi.generateSummary(
      user,
      projectId,
      dto.language ?? 'ar',
      dto.regenerate ?? false,
    );
  }

  // ---------- AI: tasks from the selected handbook ----------

  @Post('task-suggestions')
  @HttpCode(HttpStatus.OK)
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary:
      'Extract task suggestions from the selected handbook (project students)',
    description:
      'Suggestions only: every suggestion quotes the handbook (unverifiable ones are dropped) and repeats of ' +
      'existing tasks are removed. The team leader applies the selected ones with ' +
      'POST /projects/:projectId/ai-task-suggestions/apply { aiRequestId, items: [{ suggestionId }] } ' +
      '(idempotent: applying twice never duplicates a task). Supervisors cannot use this.',
  })
  @ApiOkResponse({ type: HandbookTasksResultDto })
  @ApiResponse({ status: 404, description: 'HANDBOOK_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'HANDBOOK_NOT_READABLE' })
  @ApiResponse({ status: 429, description: 'AI_RATE_LIMITED' })
  @ApiResponse({
    status: 502,
    description: 'AI_INVALID_RESPONSE or AI_PROVIDER_ERROR',
  })
  extractTasks(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Body() dto: ExtractHandbookTasksDto,
  ) {
    return this.handbookAi.extractTasks(user, projectId, dto.language ?? 'ar');
  }
}
