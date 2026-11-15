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
import { MessageDto } from '@modules/teams/dto/team-response.dto';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import {
  DeadlineQueryDto,
  TaskQueryDto,
  UpcomingQueryDto,
} from './dto/task-query.dto';
import { TaskPageDto, TaskViewDto } from './dto/task-response.dto';

@Controller('tasks')
@ApiTags('Tasks')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles([UserRole.STUDENT, UserRole.SUPERVISOR])
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
@ApiResponse({
  status: 403,
  description:
    'Role not allowed, PROJECT_ACCESS_DENIED, NOT_TEAM_LEADER, TASK_NOT_ASSIGNED_TO_YOU or TASK_STATUS_ONLY',
})
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Post()
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary: 'Create a task (team leader)',
    description:
      'assignedStudentId must be a student of the team; milestoneId must belong to the same project. ' +
      'completedAt is set automatically when status is COMPLETED.',
  })
  @ApiCreatedResponse({ type: TaskViewDto })
  @ApiResponse({
    status: 400,
    description:
      'Validation error, ASSIGNEE_NOT_IN_TEAM or MILESTONE_PROJECT_MISMATCH',
  })
  @ApiResponse({
    status: 404,
    description: 'PROJECT_NOT_FOUND or MILESTONE_NOT_FOUND',
  })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTaskDto) {
    return this.tasksService.create(user, dto);
  }

  @Get()
  @ApiOperation({
    summary: 'List tasks with filters (status, assignee, project, deadline)',
    description:
      'Students see their own project; supervisors see the projects they supervise. ' +
      'Default sort: dueDate ascending, tasks without a deadline last.',
  })
  @ApiOkResponse({ type: TaskPageDto })
  @ApiResponse({
    status: 400,
    description: 'Invalid filter or INVALID_DATE_RANGE',
  })
  findMany(@CurrentUser() user: AuthUser, @Query() query: TaskQueryDto) {
    return this.tasksService.findMany(user, query);
  }

  @Get('overdue')
  @ApiOperation({
    summary: 'Overdue tasks',
    description:
      'dueDate in the past and status TODO, IN_PROGRESS, IN_REVIEW or BLOCKED.',
  })
  @ApiOkResponse({ type: TaskPageDto })
  findOverdue(@CurrentUser() user: AuthUser, @Query() query: DeadlineQueryDto) {
    return this.tasksService.findOverdue(user, query);
  }

  @Get('upcoming')
  @ApiOperation({
    summary: 'Upcoming tasks',
    description:
      'Open tasks due between now and now + days (default 7, max 90).',
  })
  @ApiOkResponse({ type: TaskPageDto })
  findUpcoming(
    @CurrentUser() user: AuthUser,
    @Query() query: UpcomingQueryDto,
  ) {
    return this.tasksService.findUpcoming(user, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a task' })
  @ApiOkResponse({ type: TaskViewDto })
  @ApiResponse({ status: 404, description: 'TASK_NOT_FOUND' })
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tasksService.findOne(user, id);
  }

  @Patch(':id')
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary:
      'Update a task — team leader: any field incl. (re)assignment; member: status of own task only',
    description:
      'Team leader: send null to clear description, assignedStudentId, milestoneId or dueDate; reassigning notifies the new assignee. ' +
      'Member: may send only { status } for a task assigned to them (403 TASK_STATUS_ONLY / TASK_NOT_ASSIGNED_TO_YOU otherwise). ' +
      'Supervisors have read-only access.',
  })
  @ApiOkResponse({ type: TaskViewDto })
  @ApiResponse({
    status: 400,
    description:
      'Validation error, ASSIGNEE_NOT_IN_TEAM or MILESTONE_PROJECT_MISMATCH',
  })
  @ApiResponse({
    status: 404,
    description: 'TASK_NOT_FOUND or MILESTONE_NOT_FOUND',
  })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateTaskDto,
  ) {
    return this.tasksService.update(user, id, dto);
  }

  @Delete(':id')
  @Roles([UserRole.STUDENT])
  @ApiOperation({ summary: 'Delete a task (team leader)' })
  @ApiOkResponse({ type: MessageDto })
  @ApiResponse({ status: 404, description: 'TASK_NOT_FOUND' })
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tasksService.remove(user, id);
  }
}
