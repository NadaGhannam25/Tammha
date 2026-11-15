import {
  Body,
  Controller,
  Delete,
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
import { PaginationDto } from '@common/dtos/pagination.dto';
import { TaskCommentsService } from './task-comments.service';
import {
  TaskCommentInputDto,
  TaskCommentPageDto,
  TaskCommentViewDto,
} from './dto/task-comment.dto';

@Controller('tasks/:taskId/comments')
@ApiTags('Tasks')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles([UserRole.STUDENT, UserRole.SUPERVISOR])
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
@ApiResponse({ status: 403, description: 'PROJECT_ACCESS_DENIED' })
@ApiResponse({ status: 404, description: 'TASK_NOT_FOUND' })
export class TaskCommentsController {
  constructor(private readonly comments: TaskCommentsService) {}

  @Get()
  @ApiOperation({
    summary: 'Comments on a task (oldest first)',
    description: "Students of the task's project and its supervisor.",
  })
  @ApiOkResponse({ type: TaskCommentPageDto })
  list(
    @CurrentUser() user: AuthUser,
    @Param('taskId') taskId: string,
    @Query() query: PaginationDto,
  ) {
    return this.comments.list(user, taskId, query);
  }

  @Post()
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary: 'Comment on a task (students of the project team)',
    description:
      'The author and the time are stored. The assignee and the task creator are notified. ' +
      'Supervisors write task feedback instead (POST /tasks/:taskId/feedback).',
  })
  @ApiCreatedResponse({ type: TaskCommentViewDto })
  @ApiResponse({
    status: 400,
    description: 'COMMENT_EMPTY or validation error',
  })
  create(
    @CurrentUser() user: AuthUser,
    @Param('taskId') taskId: string,
    @Body() dto: TaskCommentInputDto,
  ) {
    return this.comments.create(user, taskId, dto);
  }

  @Patch(':commentId')
  @Roles([UserRole.STUDENT])
  @ApiOperation({ summary: 'Edit your own comment' })
  @ApiOkResponse({ type: TaskCommentViewDto })
  @ApiResponse({ status: 403, description: 'COMMENT_NOT_AUTHOR' })
  @ApiResponse({ status: 404, description: 'COMMENT_NOT_FOUND' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('taskId') taskId: string,
    @Param('commentId') commentId: string,
    @Body() dto: TaskCommentInputDto,
  ) {
    return this.comments.update(user, taskId, commentId, dto);
  }

  @Delete(':commentId')
  @Roles([UserRole.STUDENT])
  @ApiOperation({ summary: 'Delete a comment (its author or the team leader)' })
  @ApiOkResponse({
    schema: { type: 'object', properties: { deleted: { type: 'boolean' } } },
  })
  @ApiResponse({ status: 403, description: 'COMMENT_DELETE_NOT_ALLOWED' })
  @ApiResponse({ status: 404, description: 'COMMENT_NOT_FOUND' })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('taskId') taskId: string,
    @Param('commentId') commentId: string,
  ) {
    return this.comments.remove(user, taskId, commentId);
  }
}
