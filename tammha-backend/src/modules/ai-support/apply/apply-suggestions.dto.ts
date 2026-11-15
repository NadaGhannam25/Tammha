import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Priority } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Trim } from '@common/utils/trim.transform';
import { TaskViewDto } from '@modules/tasks/dto/task-response.dto';

export const MAX_APPLY_ITEMS = 20;

/** One selected suggestion; every field except suggestionId is an optional edit. */
export class ApplyAiTaskItemDto {
  @ApiProperty({
    example: 't1',
    description: 'taskSuggestions[].id of the AI answer',
  })
  @IsString()
  @Matches(/^t\d{1,2}$/)
  suggestionId!: string;

  @ApiPropertyOptional({ minLength: 2, maxLength: 200 })
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ maxLength: 5000 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({ enum: Priority })
  @IsOptional()
  @IsEnum(Priority)
  priority?: Priority;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 60,
    description: 'Estimated duration in days',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60)
  estimatedDays?: number;

  @ApiPropertyOptional({ example: '2026-11-30T21:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @ApiPropertyOptional({
    description:
      'Milestone of this project. When omitted, the suggested milestone title is matched (case-insensitive).',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  milestoneId?: string;

  @ApiPropertyOptional({ description: 'A STUDENT member of the project team' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  assignedStudentId?: string;
}

export class ApplyAiTaskSuggestionsDto {
  @ApiProperty({
    description:
      'Your COMPLETED AI request (TASK_BREAKDOWN or any answer with task suggestions)',
  })
  @IsString()
  @IsNotEmpty()
  aiRequestId!: string;

  @ApiProperty({
    type: [ApplyAiTaskItemDto],
    minItems: 1,
    maxItems: MAX_APPLY_ITEMS,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_APPLY_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => ApplyAiTaskItemDto)
  items!: ApplyAiTaskItemDto[];
}

export class AppliedSuggestionRefDto {
  @ApiProperty() suggestionId!: string;
  @ApiProperty() taskId!: string;
}

export class SkippedSuggestionDto {
  @ApiProperty() suggestionId!: string;
  @ApiProperty({
    enum: ['DUPLICATE_TITLE'],
    description:
      'DUPLICATE_TITLE: an open task with the same title already exists',
  })
  reason!: 'DUPLICATE_TITLE';
  @ApiProperty({ nullable: true, type: String }) existingTaskId!: string | null;
}

export class ApplyAiTaskSuggestionsResultDto {
  @ApiProperty({
    type: [TaskViewDto],
    description: 'Tasks created now (source AI_SUGGESTION)',
  })
  created!: TaskViewDto[];
  @ApiProperty({
    type: [AppliedSuggestionRefDto],
    description:
      'Suggestions already applied earlier (idempotent: nothing created again)',
  })
  alreadyApplied!: AppliedSuggestionRefDto[];
  @ApiProperty({ type: [SkippedSuggestionDto] })
  skipped!: SkippedSuggestionDto[];
}
