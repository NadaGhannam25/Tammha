import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AiMessageRole, AiRequestKind } from '@prisma/client';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PageMetaDto, PaginationDto } from '@common/dtos/pagination.dto';
import { Trim } from '@common/utils/trim.transform';
import { ACTIVE_AI_KINDS } from '../features/ai-features';
import {
  AI_LANGUAGES,
  AiRequestViewDto,
  GuidanceDto,
} from '../dto/ai-request.dto';

export const DEFAULT_CONVERSATION_TITLE = 'New conversation';

export class CreateAiConversationDto {
  @ApiProperty({
    description: 'Your project (students) or a supervised project',
  })
  @IsString()
  @IsNotEmpty()
  projectId!: string;

  @ApiPropertyOptional({
    maxLength: 120,
    description: `Defaults to "${DEFAULT_CONVERSATION_TITLE}"; set from the first question otherwise`,
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title?: string;
}

export class RenameAiConversationDto {
  @ApiProperty({ maxLength: 120 })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string;
}

export class AiConversationQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Only conversations of this project' })
  @IsOptional()
  @IsString()
  projectId?: string;
}

export class SendAiMessageDto {
  @ApiPropertyOptional({
    minLength: 2,
    maxLength: 1000,
    description:
      'The message. Required for PROJECT_QUESTION (default kind); optional for the other kinds.',
    example:
      'How should we split the implementation work for the next two weeks?',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(1000)
  content?: string;

  @ApiPropertyOptional({
    enum: ACTIVE_AI_KINDS,
    default: AiRequestKind.PROJECT_QUESTION,
    description:
      'PROJECT_QUESTION (chat), NEXT_STEPS, TASK_BREAKDOWN (structured task suggestions), ' +
      'MILESTONE_GUIDANCE, HANDBOOK_GUIDANCE',
  })
  @IsOptional()
  @IsIn(ACTIVE_AI_KINDS)
  kind?: AiRequestKind;

  @ApiPropertyOptional({
    description: 'TASK_BREAKDOWN / MILESTONE_GUIDANCE focus',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  milestoneId?: string;

  @ApiPropertyOptional({ enum: AI_LANGUAGES, default: 'auto' })
  @IsOptional()
  @IsIn(AI_LANGUAGES)
  language?: (typeof AI_LANGUAGES)[number];
}

export class AiMessageViewDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: AiMessageRole }) role!: AiMessageRole;
  @ApiProperty() content!: string;
  @ApiProperty({ enum: AiRequestKind, nullable: true, type: String })
  kind!: AiRequestKind | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'ASSISTANT messages: the AI request (see /ai-support/requests/:id)',
  })
  aiRequestId!: string | null;
  @ApiProperty({
    type: GuidanceDto,
    nullable: true,
    description:
      'ASSISTANT messages: the structured answer (task suggestions etc.)',
  })
  guidance!: GuidanceDto | null;
  @ApiProperty() createdAt!: Date;
}

export class AiConversationViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() projectId!: string;
  @ApiProperty() title!: string;
  @ApiProperty() messageCount!: number;
  @ApiProperty() lastMessageAt!: Date;
  @ApiProperty() createdAt!: Date;
}

export class AiConversationDetailDto extends AiConversationViewDto {
  @ApiProperty({
    type: [AiMessageViewDto],
    description: 'Oldest first (latest 100)',
  })
  messages!: AiMessageViewDto[];
}

export class AiConversationPageDto {
  @ApiProperty({ type: [AiConversationViewDto] })
  items!: AiConversationViewDto[];
  @ApiProperty({ type: PageMetaDto }) meta!: PageMetaDto;
}

export class AiExchangeDto {
  @ApiProperty({ type: AiConversationViewDto })
  conversation!: AiConversationViewDto;
  @ApiProperty({ type: AiMessageViewDto }) userMessage!: AiMessageViewDto;
  @ApiProperty({ type: AiMessageViewDto }) assistantMessage!: AiMessageViewDto;
  @ApiProperty({ type: AiRequestViewDto }) request!: AiRequestViewDto;
}
