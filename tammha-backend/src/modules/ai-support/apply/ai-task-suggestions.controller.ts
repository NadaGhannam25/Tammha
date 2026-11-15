import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
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
import { AiTaskSuggestionsService } from './ai-task-suggestions.service';
import {
  ApplyAiTaskSuggestionsDto,
  ApplyAiTaskSuggestionsResultDto,
} from './apply-suggestions.dto';

@Controller('projects/:projectId/ai-task-suggestions')
@ApiTags('AI Task Suggestions')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles([UserRole.STUDENT])
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
@ApiResponse({
  status: 403,
  description:
    'Not a student (supervisors are read-only), PROJECT_ACCESS_DENIED or NOT_TEAM_LEADER',
})
export class AiTaskSuggestionsController {
  constructor(private readonly suggestions: AiTaskSuggestionsService) {}

  @Post('apply')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Apply selected AI task suggestions (team leader only)',
    description:
      'Creates real tasks from the selected suggestions of one of your COMPLETED AI answers, with your ' +
      'edits (title, description, priority, estimatedDays, dueDate, milestoneId, assignedStudentId). ' +
      'Validated like manual tasks. Idempotent: re-applying a suggestion returns it under alreadyApplied. ' +
      'Suggestions whose title matches an existing task are skipped. Nothing is ever created automatically.',
  })
  @ApiOkResponse({ type: ApplyAiTaskSuggestionsResultDto })
  @ApiResponse({
    status: 400,
    description:
      'Validation error, AI_SUGGESTION_NOT_FOUND, AI_SUGGESTION_DUPLICATED, ASSIGNEE_NOT_IN_TEAM or MILESTONE_PROJECT_MISMATCH',
  })
  @ApiResponse({
    status: 404,
    description: 'PROJECT_NOT_FOUND or AI_REQUEST_NOT_FOUND',
  })
  @ApiResponse({ status: 409, description: 'AI_REQUEST_NOT_COMPLETED' })
  apply(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Body() dto: ApplyAiTaskSuggestionsDto,
  ) {
    return this.suggestions.apply(user, projectId, dto);
  }
}
