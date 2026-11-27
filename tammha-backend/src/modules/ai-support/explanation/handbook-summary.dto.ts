import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { HANDBOOK_TOPICS } from './handbook-summary.schema';

export const SUMMARY_LANGUAGES = ['ar', 'en'] as const;

export class HandbookSummaryQueryDto {
  @ApiPropertyOptional({ enum: SUMMARY_LANGUAGES, default: 'ar' })
  @IsOptional()
  @IsIn(SUMMARY_LANGUAGES)
  language?: 'ar' | 'en';
}

export class GenerateHandbookSummaryDto extends HandbookSummaryQueryDto {
  @ApiPropertyOptional({
    default: false,
    description: 'true: generate again even when a summary exists',
  })
  @IsOptional()
  @IsBoolean()
  regenerate?: boolean;
}

export class ExtractHandbookTasksDto extends HandbookSummaryQueryDto {}

export class HandbookAiCoverageDto {
  @ApiProperty({ description: 'Pages of the handbook sent to the AI' })
  pagesIncluded!: number;
  @ApiProperty({ nullable: true, type: Number }) pageCount!: number | null;
  @ApiProperty({
    description:
      'true when only the first part of a very long handbook was used',
  })
  truncated!: boolean;
}

export class HandbookAiRefDto {
  @ApiProperty({
    enum: ['LIBRARY', 'PROJECT'],
    description:
      "LIBRARY = a university's official handbook; PROJECT = the PDF uploaded for this project",
  })
  source!: 'LIBRARY' | 'PROJECT';
  @ApiProperty({
    description: 'Official handbook version id or project handbook id',
  })
  id!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ description: 'Real file name of the PDF' }) fileName!: string;
  @ApiProperty({ nullable: true, type: String }) universityName!: string | null;
}

export class CheckedPointDto {
  @ApiProperty() text!: string;
  @ApiProperty({
    type: [Number],
    description: 'Checked page numbers (may be empty)',
  })
  pages!: number[];
  @ApiProperty({ nullable: true, type: String }) quote!: string | null;
  @ApiProperty({
    description:
      'true when the quote was found on the cited (or corrected) page',
  })
  verified!: boolean;
}

export class TopicTitleDto {
  @ApiProperty() ar!: string;
  @ApiProperty() en!: string;
}

export class SummaryTopicDto {
  @ApiProperty({ enum: HANDBOOK_TOPICS.map((t) => t.id) }) id!: string;
  @ApiProperty({ type: TopicTitleDto }) title!: TopicTitleDto;
  @ApiProperty({
    description:
      'false: the handbook says nothing about this topic (show "لا توجد نتائج" / "No results found")',
  })
  found!: boolean;
  @ApiProperty() summary!: string;
  @ApiProperty({ type: [CheckedPointDto] }) points!: CheckedPointDto[];
  @ApiProperty({ type: [Number] }) pages!: number[];
}

export class SummaryStatsDto {
  @ApiProperty({ example: 7 }) topics!: number;
  @ApiProperty() foundTopics!: number;
  @ApiProperty() points!: number;
  @ApiProperty() verifiedPoints!: number;
}

export class HandbookSummaryViewDto {
  @ApiProperty({
    enum: ['READY', 'NOT_GENERATED'],
    description:
      'NOT_GENERATED: POST the same URL to generate it. A failed generation is an HTTP error ' +
      '(502 AI_INVALID_RESPONSE, 503 AI_PROVIDER_UNAVAILABLE, 504 AI_PROVIDER_TIMEOUT ...), never a summary.',
  })
  status!: 'READY' | 'NOT_GENERATED';
  @ApiProperty({ enum: ['ar', 'en'] }) language!: 'ar' | 'en';
  @ApiProperty({ type: HandbookAiRefDto }) handbook!: HandbookAiRefDto;
  @ApiProperty({
    type: [SummaryTopicDto],
    description:
      'Always the seven fixed topics in the fixed order when READY; empty when NOT_GENERATED',
  })
  topics!: SummaryTopicDto[];
  @ApiProperty({ type: SummaryStatsDto, nullable: true })
  stats!: SummaryStatsDto | null;
  @ApiProperty({ type: HandbookAiCoverageDto, nullable: true })
  coverage!: HandbookAiCoverageDto | null;
  @ApiProperty({ nullable: true, type: Date }) generatedAt!: Date | null;
  @ApiProperty({ nullable: true, type: String }) model!: string | null;
  @ApiProperty({ example: true }) advisoryOnly!: true;
  @ApiProperty() disclaimer!: string;
}

export class HandbookTaskSuggestionDto {
  @ApiProperty({
    example: 't1',
    description: 'Use as suggestionId when applying',
  })
  id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ enum: ['HIGH', 'MEDIUM', 'LOW'] }) priority!: string;
  @ApiProperty({ nullable: true, type: Number }) estimatedDays!: number | null;
  @ApiProperty({
    nullable: true,
    description: 'The project stage the task belongs to (null when the project has no stages)',
  })
  milestoneId!: string | null;
  @ApiProperty({ nullable: true, type: String }) milestoneTitle!: string | null;
  @ApiProperty({ type: [Number] }) pages!: number[];
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Handbook text behind this task; null when the handbook does not describe it',
  })
  quote!: string | null;
}

export class HandbookTasksResultDto {
  @ApiProperty({
    description:
      'AI request id: pass it as aiRequestId to POST /projects/:projectId/ai-task-suggestions/apply',
  })
  aiRequestId!: string;
  @ApiProperty({ type: HandbookAiRefDto }) handbook!: HandbookAiRefDto;
  @ApiProperty({
    type: [HandbookTaskSuggestionDto],
    description: 'May be empty',
  })
  suggestions!: HandbookTaskSuggestionDto[];
  @ApiProperty({
    description:
      'Suggestions removed by the server: unverified = quote not found in the handbook; duplicates = same title as another suggestion or an existing task',
    example: { unverified: 0, duplicates: 1 },
  })
  dropped!: { unverified: number; duplicates: number };
  @ApiProperty({ type: HandbookAiCoverageDto })
  coverage!: HandbookAiCoverageDto;
  @ApiProperty({
    description:
      'true when the caller is the team leader (only the leader applies suggestions)',
  })
  canApply!: boolean;
  @ApiProperty({ example: true }) advisoryOnly!: true;
}
