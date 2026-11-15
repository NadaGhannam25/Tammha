import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FeedbackCategory, SubmissionStatus } from '@prisma/client';
import {
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { PaginationDto } from '@common/dtos/pagination.dto';
import { Trim } from '@common/utils/trim.transform';

/** Decisions a supervisor can record. UPLOADED / SUBMITTED are set by students (upload / review request). */
export const REVIEW_STATUSES = [
  SubmissionStatus.UNDER_REVIEW,
  SubmissionStatus.CHANGES_REQUESTED,
  SubmissionStatus.APPROVED,
  SubmissionStatus.REJECTED,
];

/** Fields shared by create and edit. */
class FeedbackContentDto {
  @ApiPropertyOptional({
    maxLength: 5000,
    example: 'Good structure. Expand section 3.2 with the test results.',
  })
  @ValidateIf((_, v) => v !== null)
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(5000)
  comment?: string | null;

  @ApiPropertyOptional({
    enum: FeedbackCategory,
    default: FeedbackCategory.GENERAL,
  })
  @IsOptional()
  @IsEnum(FeedbackCategory)
  category?: FeedbackCategory;
}

/** Written feedback only: Tammha does not grade students (no scores or rubrics). */
export class CreateFeedbackDto extends FeedbackContentDto {
  @ApiPropertyOptional({
    description:
      'Project feedback. Optional when documentId or taskId is given.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  projectId?: string;

  @ApiPropertyOptional({ description: 'Feedback on a document (submission)' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  documentId?: string;

  @ApiPropertyOptional({
    description:
      'Feedback on one task (not with documentId). The task itself is never changed.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  taskId?: string;

  @ApiPropertyOptional({
    enum: REVIEW_STATUSES,
    description:
      'Review decision for the document; also updates its submission status',
  })
  @IsOptional()
  @IsIn(REVIEW_STATUSES)
  status?: SubmissionStatus;
}

/** POST /tasks/:taskId/feedback */
export class TaskFeedbackDto extends FeedbackContentDto {}

/** Edit own feedback. The recorded decision (status) cannot be changed: record a new one. */
export class UpdateFeedbackDto extends FeedbackContentDto {}

export class UpdateSubmissionStatusDto {
  @ApiProperty({ enum: REVIEW_STATUSES })
  @IsIn(REVIEW_STATUSES)
  status!: SubmissionStatus;

  @ApiPropertyOptional({ maxLength: 5000 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(5000)
  comment?: string;
}

export class FeedbackQueryDto extends PaginationDto {
  @ApiPropertyOptional() @IsOptional() @IsString() projectId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() documentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() taskId?: string;

  @ApiPropertyOptional({
    enum: SubmissionStatus,
    description: 'Only feedback that recorded this decision',
  })
  @IsOptional()
  @IsEnum(SubmissionStatus)
  status?: SubmissionStatus;
}
