import {
  Body,
  Controller,
  Get,
  Param,
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
import { AISupportService } from './ai-support.service';
import {
  AiFeatureDto,
  AiLimitsDto,
  AiProjectQueryDto,
  AiRequestPageDto,
  AiRequestQueryDto,
  AiRequestViewDto,
  CreateAiRequestDto,
} from './dto/ai-request.dto';
import { ProjectHandbookDto } from './dto/handbook.dto';

@Controller('ai-support')
@ApiTags('AI Support')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles([UserRole.STUDENT, UserRole.SUPERVISOR])
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
@ApiResponse({
  status: 403,
  description: 'Role not allowed (ADMIN) or PROJECT_ACCESS_DENIED',
})
export class AISupportController {
  constructor(private readonly aiSupport: AISupportService) {}

  @Post('requests')
  @ApiOperation({
    summary: 'Ask the AI for project guidance (advisory only)',
    description:
      'Kinds: PROJECT_QUESTION (question required), NEXT_STEPS, TASK_BREAKDOWN and MILESTONE_GUIDANCE ' +
      '(optional milestoneId), HANDBOOK_GUIDANCE (needs a READY project handbook, or the university one). ' +
      'Students: own project; supervisors: supervised projects. Only a minimal project summary and the most ' +
      'relevant excerpts of the project handbook (or the university handbook) are sent to the AI provider. The answer is structured ' +
      'guidance; nothing in Tammha is changed (task suggestions become tasks only through the leader-only apply endpoint). Limits per user/hour, user/day and project/day; one request at a time.',
  })
  @ApiCreatedResponse({ type: AiRequestViewDto })
  @ApiResponse({
    status: 400,
    description:
      'Validation error, AI_QUESTION_REQUIRED, AI_MILESTONE_NOT_SUPPORTED or AI_KIND_NOT_AVAILABLE',
  })
  @ApiResponse({
    status: 404,
    description:
      'PROJECT_NOT_FOUND, AI_MILESTONE_NOT_FOUND or HANDBOOK_NOT_FOUND',
  })
  @ApiResponse({ status: 422, description: 'AI_RESPONSE_BLOCKED' })
  @ApiResponse({
    status: 429,
    description:
      'AI_RATE_LIMITED (details.scope, details.retryAfterSeconds) or AI_REQUEST_IN_PROGRESS',
  })
  @ApiResponse({
    status: 502,
    description: 'AI_INVALID_RESPONSE or AI_PROVIDER_ERROR',
  })
  @ApiResponse({
    status: 503,
    description:
      'INTEGRATION_DISABLED (AI_ENABLED=false) or AI_PROVIDER_UNAVAILABLE',
  })
  @ApiResponse({ status: 504, description: 'AI_PROVIDER_TIMEOUT' })
  ask(@CurrentUser() user: AuthUser, @Body() dto: CreateAiRequestDto) {
    return this.aiSupport.ask(user, dto);
  }

  @Get('requests')
  @ApiOperation({
    summary: 'My AI requests (newest first)',
    description: 'Only your own requests for projects you can still access.',
  })
  @ApiOkResponse({ type: AiRequestPageDto })
  list(@CurrentUser() user: AuthUser, @Query() query: AiRequestQueryDto) {
    return this.aiSupport.list(user, query);
  }

  @Get('requests/:id')
  @ApiOperation({ summary: 'One of my AI requests with its guidance' })
  @ApiOkResponse({ type: AiRequestViewDto })
  @ApiResponse({ status: 404, description: 'AI_REQUEST_NOT_FOUND' })
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.aiSupport.findOne(user, id);
  }

  @Get('limits')
  @ApiOperation({
    summary:
      'My AI usage: used, remaining and resetsAt per window (and the project quota)',
    description: 'Handbook processing never counts against these limits.',
  })
  @ApiOkResponse({ type: AiLimitsDto })
  limits(@CurrentUser() user: AuthUser, @Query() query: AiProjectQueryDto) {
    return this.aiSupport.limits(user, query.projectId);
  }

  @Get('handbook')
  @ApiOperation({
    summary: 'Which handbook the AI uses for this project',
    description:
      'The active project handbook (uploaded by the team leader) first, otherwise the university handbook. ' +
      'Metadata only. Full upload state: GET /projects/:projectId/handbook.',
  })
  @ApiOkResponse({ type: ProjectHandbookDto })
  handbook(@CurrentUser() user: AuthUser, @Query() query: AiProjectQueryDto) {
    return this.aiSupport.projectHandbook(user, query.projectId);
  }

  @Get('features')
  @ApiOperation({ summary: 'Available AI features' })
  @ApiOkResponse({ type: [AiFeatureDto] })
  features() {
    return this.aiSupport.features();
  }
}
