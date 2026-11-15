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
import { AiConversationsService } from './ai-conversations.service';
import {
  AiConversationDetailDto,
  AiConversationPageDto,
  AiConversationQueryDto,
  AiConversationViewDto,
  AiExchangeDto,
  CreateAiConversationDto,
  RenameAiConversationDto,
  SendAiMessageDto,
} from './ai-conversation.dto';

@Controller('ai-support/conversations')
@ApiTags('AI Conversations')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles([UserRole.STUDENT, UserRole.SUPERVISOR])
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
@ApiResponse({
  status: 403,
  description: 'Role not allowed (ADMIN) or PROJECT_ACCESS_DENIED',
})
export class AiConversationsController {
  constructor(private readonly conversations: AiConversationsService) {}

  @Post()
  @ApiOperation({
    summary: 'Start a side-chat conversation for a project',
    description: 'Private to you; scoped to one project you can access.',
  })
  @ApiCreatedResponse({ type: AiConversationViewDto })
  @ApiResponse({ status: 404, description: 'PROJECT_NOT_FOUND' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateAiConversationDto) {
    return this.conversations.create(user, dto);
  }

  @Get()
  @ApiOperation({
    summary: 'Your conversations (latest activity first)',
    description: 'Only projects you can still access.',
  })
  @ApiOkResponse({ type: AiConversationPageDto })
  list(@CurrentUser() user: AuthUser, @Query() query: AiConversationQueryDto) {
    return this.conversations.list(user, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Open a conversation with its messages' })
  @ApiOkResponse({ type: AiConversationDetailDto })
  @ApiResponse({ status: 404, description: 'AI_CONVERSATION_NOT_FOUND' })
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.conversations.findOne(user, id);
  }

  @Post(':id/messages')
  @ApiOperation({
    summary: 'Continue the conversation (one AI request)',
    description:
      'Runs the project-aware AI pipeline with the latest messages as context. Default kind ' +
      'PROJECT_QUESTION; TASK_BREAKDOWN returns structured task suggestions that only the team leader ' +
      'can apply. Counts against the AI limits. Messages are saved only when the AI answers.',
  })
  @ApiCreatedResponse({ type: AiExchangeDto })
  @ApiResponse({
    status: 400,
    description:
      'Validation error, AI_QUESTION_REQUIRED, AI_KIND_NOT_AVAILABLE or AI_MILESTONE_NOT_SUPPORTED',
  })
  @ApiResponse({
    status: 404,
    description:
      'AI_CONVERSATION_NOT_FOUND, AI_MILESTONE_NOT_FOUND or HANDBOOK_NOT_FOUND',
  })
  @ApiResponse({
    status: 429,
    description: 'AI_RATE_LIMITED or AI_REQUEST_IN_PROGRESS',
  })
  @ApiResponse({
    status: 502,
    description: 'AI_INVALID_RESPONSE or AI_PROVIDER_ERROR',
  })
  @ApiResponse({
    status: 503,
    description: 'AI_PROVIDER_UNAVAILABLE or INTEGRATION_DISABLED',
  })
  @ApiResponse({ status: 504, description: 'AI_PROVIDER_TIMEOUT' })
  send(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: SendAiMessageDto,
  ) {
    return this.conversations.send(user, id, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename a conversation' })
  @ApiOkResponse({ type: AiConversationViewDto })
  @ApiResponse({ status: 404, description: 'AI_CONVERSATION_NOT_FOUND' })
  rename(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: RenameAiConversationDto,
  ) {
    return this.conversations.rename(user, id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a conversation and its messages',
    description: 'AI request records stay (they count for the limits).',
  })
  @ApiOkResponse({
    schema: { type: 'object', properties: { deleted: { type: 'boolean' } } },
  })
  @ApiResponse({ status: 404, description: 'AI_CONVERSATION_NOT_FOUND' })
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.conversations.remove(user, id);
  }
}
