import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
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
import { TaskAttachmentsService } from './task-attachments.service';
import {
  AddTaskAttachmentDto,
  TaskAttachmentViewDto,
} from './dto/task-attachment.dto';

@Controller('tasks/:taskId/attachments')
@ApiTags('Tasks')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles([UserRole.STUDENT, UserRole.SUPERVISOR])
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
@ApiResponse({ status: 403, description: 'PROJECT_ACCESS_DENIED' })
@ApiResponse({ status: 404, description: 'TASK_NOT_FOUND' })
export class TaskAttachmentsController {
  constructor(private readonly attachments: TaskAttachmentsService) {}

  @Get()
  @ApiOperation({
    summary: 'Files attached to a task',
    description:
      "Project files linked to the task (oldest first). Students of the task's project and its supervisor. " +
      'Open a file with GET /documents/:documentId.',
  })
  @ApiOkResponse({ type: [TaskAttachmentViewDto] })
  list(@CurrentUser() user: AuthUser, @Param('taskId') taskId: string) {
    return this.attachments.list(user, taskId);
  }

  @Post()
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary: 'Attach a project file to a task',
    description:
      "Team Leader or the task's assignee. The file must belong to the task's project. Returns the new list.",
  })
  @ApiOkResponse({ type: [TaskAttachmentViewDto] })
  @ApiResponse({
    status: 400,
    description: 'ATTACHMENT_DOCUMENT_INVALID (not a file of this project)',
  })
  @ApiResponse({ status: 409, description: 'ATTACHMENT_EXISTS' })
  add(
    @CurrentUser() user: AuthUser,
    @Param('taskId') taskId: string,
    @Body() dto: AddTaskAttachmentDto,
  ) {
    return this.attachments.add(user, taskId, dto);
  }

  @Delete(':attachmentId')
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary: 'Remove a file from a task',
    description:
      "Team Leader or the task's assignee. The file stays in the project files. Returns the new list.",
  })
  @ApiOkResponse({ type: [TaskAttachmentViewDto] })
  @ApiResponse({ status: 404, description: 'ATTACHMENT_NOT_FOUND' })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('taskId') taskId: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    return this.attachments.remove(user, taskId, attachmentId);
  }
}
