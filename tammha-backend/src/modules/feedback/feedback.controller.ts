import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '@modules/auth/guards/roles.guard';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { AuthUser } from '@common/types/auth-user.type';
import { FeedbackService } from './feedback.service';
import {
  CreateFeedbackDto,
  FeedbackQueryDto,
  TaskFeedbackDto,
  UpdateFeedbackDto,
} from './dto/feedback.dto';
import { PaginationDto } from '@common/dtos/pagination.dto';
import { FeedbackPageDto, FeedbackViewDto } from './dto/feedback-response.dto';

@Controller('feedback')
@ApiTags('Feedback')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles([UserRole.STUDENT, UserRole.SUPERVISOR])
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
@ApiResponse({
  status: 403,
  description: 'Role not allowed, PROJECT_ACCESS_DENIED or FEEDBACK_NOT_OWNER',
})
export class FeedbackController {
  constructor(private readonly feedbackService: FeedbackService) {}

  @Post()
  @Roles([UserRole.SUPERVISOR])
  @ApiOperation({
    summary:
      'Give written feedback on a project, a document or a task (supervisor of the project)',
    description:
      'Send projectId (project feedback), documentId (document/submission feedback) or taskId (task feedback). ' +
      'comment and/or status (review decision, documents only). Written feedback only: no scores or rubrics. ' +
      'Feedback on a task never changes the task. Students of the project are notified.',
  })
  @ApiCreatedResponse({ type: FeedbackViewDto })
  @ApiResponse({
    status: 400,
    description:
      'Validation error, FEEDBACK_TARGET_REQUIRED, FEEDBACK_EMPTY, STATUS_REQUIRES_DOCUMENT, DOCUMENT_PROJECT_MISMATCH or TASK_PROJECT_MISMATCH',
  })
  @ApiResponse({
    status: 404,
    description: 'PROJECT_NOT_FOUND, DOCUMENT_NOT_FOUND or TASK_NOT_FOUND',
  })
  @ApiResponse({ status: 409, description: 'SUBMISSION_STATUS_UNCHANGED' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateFeedbackDto) {
    return this.feedbackService.create(user, dto);
  }

  @Get()
  @ApiOperation({
    summary: 'Feedback history (newest first)',
    description:
      'Students: their projects. Supervisors: projects they supervise. Filter by projectId, documentId, taskId, status.',
  })
  @ApiOkResponse({ type: FeedbackPageDto })
  findMany(@CurrentUser() user: AuthUser, @Query() query: FeedbackQueryDto) {
    return this.feedbackService.findMany(user, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one feedback item' })
  @ApiOkResponse({ type: FeedbackViewDto })
  @ApiResponse({ status: 404, description: 'FEEDBACK_NOT_FOUND' })
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.feedbackService.findOne(user, id);
  }

  @Patch(':id')
  @Roles([UserRole.SUPERVISOR])
  @ApiOperation({
    summary: 'Edit your own feedback',
    description:
      'Editable: comment, category (null clears the comment). ' +
      'The recorded decision (status) cannot be changed: record a new decision instead.',
  })
  @ApiOkResponse({ type: FeedbackViewDto })
  @ApiResponse({
    status: 400,
    description: 'Validation error or FEEDBACK_EMPTY',
  })
  @ApiResponse({ status: 404, description: 'FEEDBACK_NOT_FOUND' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateFeedbackDto,
  ) {
    return this.feedbackService.update(user, id, dto);
  }
}

/** Supervisor feedback on one task (same records as /feedback?taskId=...). */
@Controller('tasks/:taskId/feedback')
@ApiTags('Feedback')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles([UserRole.STUDENT, UserRole.SUPERVISOR])
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
@ApiResponse({ status: 403, description: 'PROJECT_ACCESS_DENIED' })
@ApiResponse({ status: 404, description: 'TASK_NOT_FOUND' })
export class TaskFeedbackController {
  constructor(private readonly feedbackService: FeedbackService) {}

  @Post()
  @Roles([UserRole.SUPERVISOR])
  @ApiOperation({
    summary: "Write feedback on a task (the project's supervisor)",
    description:
      'The supervisor comments on the task; the task itself (title, assignee, status, dates) is never changed. ' +
      'Students of the project are notified.',
  })
  @ApiCreatedResponse({ type: FeedbackViewDto })
  @ApiResponse({
    status: 400,
    description: 'Validation error or FEEDBACK_EMPTY',
  })
  create(
    @CurrentUser() user: AuthUser,
    @Param('taskId') taskId: string,
    @Body() dto: TaskFeedbackDto,
  ) {
    return this.feedbackService.create(user, {
      taskId,
      comment: dto.comment,
      category: dto.category,
    });
  }

  @Get()
  @ApiOperation({
    summary: 'Supervisor feedback on a task (newest first)',
    description: "Students of the task's project and its supervisor.",
  })
  @ApiOkResponse({ type: FeedbackPageDto })
  list(
    @CurrentUser() user: AuthUser,
    @Param('taskId') taskId: string,
    @Query() query: PaginationDto,
  ) {
    return this.feedbackService.findMany(user, { ...query, taskId });
  }
}
