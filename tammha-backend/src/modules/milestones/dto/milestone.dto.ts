import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MilestoneStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  Max,
  Min,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PageMetaDto, PaginationDto } from '@common/dtos/pagination.dto';
import { Trim } from '@common/utils/trim.transform';
import { QueryBoolean } from '@common/utils/query-boolean.transform';

/**
 * Statuses a student can set. OVERDUE exists in the database enum but is not
 * stored by this API: overdue is computed from dueDate (see isOverdue).
 */
export const SETTABLE_MILESTONE_STATUSES = [
  MilestoneStatus.PENDING,
  MilestoneStatus.IN_PROGRESS,
  MilestoneStatus.COMPLETED,
  MilestoneStatus.CANCELLED,
];

export class CreateMilestoneDto {
  @ApiProperty({
    description: 'Project the milestone belongs to (must be your own project)',
  })
  @IsString()
  @IsNotEmpty()
  projectId!: string;

  @ApiProperty({
    example: 'Chapter 3 — System Design',
    minLength: 2,
    maxLength: 200,
  })
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ maxLength: 5000 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiProperty({
    example: '2026-12-01T21:00:00.000Z',
    description: 'ISO 8601 date/time',
  })
  @IsDateString()
  dueDate!: string;

  @ApiPropertyOptional({
    enum: SETTABLE_MILESTONE_STATUSES,
    default: MilestoneStatus.PENDING,
  })
  @IsOptional()
  @IsIn(SETTABLE_MILESTONE_STATUSES)
  status?: MilestoneStatus;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100,
    nullable: true,
    description:
      'P16: position of this stage in the project (1 = first). Stages without an order follow, by due date.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  order?: number | null;
}

export class UpdateMilestoneDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 200 })
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({
    maxLength: 5000,
    nullable: true,
    description: 'null clears it',
  })
  @ValidateIf((_, v) => v !== null)
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(5000)
  description?: string | null;

  @ApiPropertyOptional({ example: '2026-12-01T21:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @ApiPropertyOptional({ enum: SETTABLE_MILESTONE_STATUSES })
  @IsOptional()
  @IsIn(SETTABLE_MILESTONE_STATUSES)
  status?: MilestoneStatus;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100,
    nullable: true,
    description:
      'P16: position of this stage in the project (1 = first). Stages without an order follow, by due date.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  order?: number | null;
}

export class MilestoneQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Limit to one accessible project' })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({ enum: SETTABLE_MILESTONE_STATUSES, isArray: true })
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === ''
      ? undefined
      : (Array.isArray(value) ? value : String(value).split(',')).map((v) =>
          String(v).trim(),
        ),
  )
  @ArrayMaxSize(4)
  @IsIn(SETTABLE_MILESTONE_STATUSES, { each: true })
  status?: MilestoneStatus[];

  @ApiPropertyOptional({ description: 'true = only overdue milestones' })
  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  overdue?: boolean;
}

export class MilestoneProgressDto {
  @ApiProperty({ description: 'Linked tasks, excluding CANCELLED' })
  totalTasks!: number;
  @ApiProperty() completedTasks!: number;
  @ApiProperty({ description: 'TODO + IN_PROGRESS + IN_REVIEW + BLOCKED' })
  openTasks!: number;
  @ApiProperty({ description: 'Open linked tasks past their own deadline' })
  overdueTasks!: number;
  @ApiProperty({
    description: 'completed / total × 100, rounded; 0 when there are no tasks',
  })
  percent!: number;
}

export class MilestoneViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() projectId!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty() dueDate!: Date;
  @ApiProperty({ enum: MilestoneStatus }) status!: MilestoneStatus;
  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      'Stage position (1 = first); lists are ordered by order, then due date',
  })
  order!: number | null;
  @ApiProperty({
    description: 'dueDate passed and status not COMPLETED/CANCELLED',
  })
  isOverdue!: boolean;
  @ApiProperty({ type: MilestoneProgressDto }) progress!: MilestoneProgressDto;
  @ApiProperty() createdById!: string;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class MilestonePageDto {
  @ApiProperty({ type: [MilestoneViewDto] }) items!: MilestoneViewDto[];
  @ApiProperty({ type: PageMetaDto }) meta!: PageMetaDto;
}
