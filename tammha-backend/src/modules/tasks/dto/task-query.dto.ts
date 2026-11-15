import { ApiPropertyOptional } from '@nestjs/swagger';
import { Priority, TaskStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationDto } from '@common/dtos/pagination.dto';
import { QueryBoolean } from '@common/utils/query-boolean.transform';

/** Accepts ?status=TODO&status=IN_PROGRESS or ?status=TODO,IN_PROGRESS */
const CsvArray = () =>
  Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return undefined;
    const list = Array.isArray(value) ? value : String(value).split(',');
    return list.map((v) => String(v).trim()).filter(Boolean);
  });

export const TASK_SORT_FIELDS = [
  'dueDate',
  'priority',
  'createdAt',
  'updatedAt',
  'title',
] as const;
export type TaskSortField = (typeof TASK_SORT_FIELDS)[number];

export class TaskQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    description:
      'Limit to one project. Students: defaults to their project. Supervisors: defaults to all supervised projects.',
  })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({
    enum: TaskStatus,
    isArray: true,
    description: 'One or more (comma-separated or repeated)',
  })
  @IsOptional()
  @CsvArray()
  @ArrayMaxSize(6)
  @IsEnum(TaskStatus, { each: true })
  status?: TaskStatus[];

  @ApiPropertyOptional({ enum: Priority, isArray: true })
  @IsOptional()
  @CsvArray()
  @ArrayMaxSize(4)
  @IsEnum(Priority, { each: true })
  priority?: Priority[];

  @ApiPropertyOptional({
    description:
      'Assignee user id, "me" for your own tasks, or "none" for unassigned tasks',
  })
  @IsOptional()
  @IsString()
  assignedStudentId?: string;

  @ApiPropertyOptional({
    description: 'Milestone id, or "none" for tasks without a milestone',
  })
  @IsOptional()
  @IsString()
  milestoneId?: string;

  @ApiPropertyOptional({ description: 'Deadline on or after (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  dueFrom?: string;

  @ApiPropertyOptional({ description: 'Deadline on or before (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  dueTo?: string;

  @ApiPropertyOptional({
    description: 'true = only tasks that have no deadline',
  })
  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  noDueDate?: boolean;

  @ApiPropertyOptional({ description: 'Case-insensitive search in title' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ enum: TASK_SORT_FIELDS, default: 'dueDate' })
  @IsOptional()
  @IsIn(TASK_SORT_FIELDS)
  sortBy?: TaskSortField;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'asc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';
}

export class DeadlineQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Limit to one accessible project' })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({ description: '"me" = only tasks assigned to you' })
  @IsOptional()
  @IsString()
  assignedStudentId?: string;
}

export class UpcomingQueryDto extends DeadlineQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 90,
    default: 7,
    description: 'Look-ahead window in days',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;
}
