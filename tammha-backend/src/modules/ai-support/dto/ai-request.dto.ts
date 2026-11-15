import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AiRequestKind, AISupportStatus } from '@prisma/client';
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
import { CONFIDENCE, PRIORITIES } from '../guidance/guidance.schema';

export const AI_LANGUAGES = ['auto', 'en', 'ar'] as const;

export class CreateAiRequestDto {
  @ApiProperty({
    description:
      'Your project (students) or a supervised project (supervisors)',
  })
  @IsString()
  @IsNotEmpty()
  projectId!: string;

  @ApiProperty({
    enum: ACTIVE_AI_KINDS,
    description:
      'PROJECT_QUESTION (needs question), NEXT_STEPS, TASK_BREAKDOWN, MILESTONE_GUIDANCE, ' +
      'HANDBOOK_GUIDANCE (needs a READY project handbook, or the university one)',
  })
  @IsIn(ACTIVE_AI_KINDS)
  kind!: AiRequestKind;

  @ApiPropertyOptional({
    minLength: 5,
    maxLength: 1000,
    example: 'What must the final report contain and how long can it be?',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  question?: string;

  @ApiPropertyOptional({
    description: 'Focus on one milestone (TASK_BREAKDOWN, MILESTONE_GUIDANCE)',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  milestoneId?: string;

  @ApiPropertyOptional({
    enum: AI_LANGUAGES,
    default: 'auto',
    description:
      'auto = Arabic when the question is in Arabic, otherwise English',
  })
  @IsOptional()
  @IsIn(AI_LANGUAGES)
  language?: (typeof AI_LANGUAGES)[number];
}

export class AiRequestQueryDto extends PaginationDto {
  @ApiPropertyOptional() @IsOptional() @IsString() projectId?: string;

  @ApiPropertyOptional({ enum: AiRequestKind })
  @IsOptional()
  @IsIn(Object.values(AiRequestKind))
  kind?: AiRequestKind;
}

export class AiProjectQueryDto {
  @ApiProperty() @IsString() @IsNotEmpty() projectId!: string;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export class RecommendationDto {
  @ApiProperty() title!: string;
  @ApiProperty() detail!: string;
  @ApiProperty({ enum: PRIORITIES }) priority!: string;
}
export class TaskSuggestionDto {
  @ApiProperty({
    example: 't1',
    description: 'Stable id inside this answer, used to apply the suggestion',
  })
  id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ enum: PRIORITIES }) priority!: string;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Estimated duration in days',
  })
  estimatedDays!: number | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Related milestone title',
  })
  milestone!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Task created from this suggestion by the team leader (null = not applied)',
  })
  appliedTaskId!: string | null;
}
export class MilestoneSuggestionDto {
  @ApiProperty() title!: string;
  @ApiProperty() description!: string;
  @ApiProperty() suggestedOrder!: number;
  @ApiProperty({ nullable: true, type: String, example: '2027-02-15' })
  suggestedDueDate!: string | null;
}
export class HandbookReferenceDto {
  @ApiProperty({ example: 'H2' }) excerptId!: string;
  @ApiProperty() page!: number;
  @ApiProperty({ nullable: true, type: String }) section!: string | null;
  @ApiProperty({ description: 'Text from the handbook itself (not generated)' })
  quote!: string;
  @ApiProperty() note!: string;
}
export class GuidanceDto {
  @ApiProperty() summary!: string;
  @ApiProperty({ nullable: true, type: String }) answer!: string | null;
  @ApiProperty({ type: [RecommendationDto] })
  recommendations!: RecommendationDto[];
  @ApiProperty({ type: [String] }) nextSteps!: string[];
  @ApiProperty({
    type: [TaskSuggestionDto],
    description:
      'Suggestions only: nothing is created until the team leader applies selected ones ' +
      '(POST /projects/:projectId/ai-task-suggestions/apply)',
  })
  taskSuggestions!: TaskSuggestionDto[];
  @ApiProperty({
    type: [MilestoneSuggestionDto],
    description: 'Suggestions only: nothing is created',
  })
  milestoneSuggestions!: MilestoneSuggestionDto[];
  @ApiProperty({ type: [HandbookReferenceDto] })
  handbookReferences!: HandbookReferenceDto[];
  @ApiProperty({ type: [String] }) risks!: string[];
  @ApiProperty({ enum: CONFIDENCE }) confidence!: string;
}
export class AiHandbookUsageDto {
  @ApiProperty() used!: boolean;
  @ApiProperty({
    enum: ['LIBRARY', 'PROJECT', 'UNIVERSITY'],
    nullable: true,
    type: String,
    description:
      'LIBRARY = the university handbook selected for the project; PROJECT = handbook uploaded by the team leader; UNIVERSITY = only in older answers (the former automatic fallback, no longer used)',
  })
  source!: 'LIBRARY' | 'PROJECT' | 'UNIVERSITY' | null;
  @ApiProperty({ nullable: true, type: String }) title!: string | null;
  @ApiProperty() excerptsUsed!: number;
}
export class AiRequestViewDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true, type: String }) projectId!: string | null;
  @ApiProperty({ enum: AiRequestKind }) kind!: AiRequestKind;
  @ApiProperty({ enum: AISupportStatus }) status!: AISupportStatus;
  @ApiProperty({ nullable: true, type: String }) question!: string | null;
  @ApiProperty({ enum: ['en', 'ar'], nullable: true, type: String }) language!:
    string | null;
  @ApiProperty({ type: GuidanceDto, nullable: true })
  guidance!: GuidanceDto | null;
  @ApiProperty({ type: AiHandbookUsageDto }) handbook!: AiHandbookUsageDto;
  @ApiProperty({ nullable: true, type: String }) provider!: string | null;
  @ApiProperty({ nullable: true, type: String }) model!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Set when status is FAILED',
  })
  errorCode!: string | null;
  @ApiProperty({ nullable: true, type: Number }) latencyMs!: number | null;
  @ApiProperty({
    description:
      'Always true: AI output never changes grades, readiness or data',
  })
  advisoryOnly!: true;
  @ApiProperty() disclaimer!: string;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ nullable: true, type: Date }) completedAt!: Date | null;
}
export class AiRequestPageDto {
  @ApiProperty({ type: [AiRequestViewDto] }) items!: AiRequestViewDto[];
  @ApiProperty({ type: PageMetaDto }) meta!: PageMetaDto;
}
export class AiQuotaDto {
  @ApiProperty() limit!: number;
  @ApiProperty() used!: number;
  @ApiProperty() remaining!: number;
  @ApiProperty({ enum: ['1h', '24h'], description: 'Rolling window' })
  window!: '1h' | '24h';
  @ApiProperty({
    nullable: true,
    type: Date,
    description:
      'When the oldest request in the window expires and one more request becomes available (null = window empty)',
  })
  resetsAt!: Date | null;
}
export class AiLimitsDto {
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ type: AiQuotaDto, description: 'Your requests, rolling hour' })
  hourly!: AiQuotaDto;
  @ApiProperty({ type: AiQuotaDto, description: 'Your requests, rolling 24 h' })
  daily!: AiQuotaDto;
  @ApiProperty({
    type: AiQuotaDto,
    description: 'All members of the project, rolling 24 h',
  })
  project!: AiQuotaDto;
  @ApiProperty({
    description:
      'Always false: handbook upload and processing never count against these limits',
  })
  countsHandbookProcessing!: false;
}
export class AiFeatureDto {
  @ApiProperty({ enum: AiRequestKind }) kind!: AiRequestKind;
  @ApiProperty() label!: string;
  @ApiProperty() requiresQuestion!: boolean;
  @ApiProperty() requiresHandbook!: boolean;
  @ApiProperty() acceptsMilestone!: boolean;
}
