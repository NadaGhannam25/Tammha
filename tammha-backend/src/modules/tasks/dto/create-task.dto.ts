import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Priority, TaskStatus } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Trim } from '@common/utils/trim.transform';

export class CreateTaskDto {
  @ApiProperty({
    description: 'Project the task belongs to (must be your own project)',
  })
  @IsString()
  @IsNotEmpty()
  projectId!: string;

  @ApiProperty({
    example: 'Design the database schema',
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

  @ApiPropertyOptional({
    description: 'User id of a STUDENT member of the project team',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  assignedStudentId?: string;

  @ApiPropertyOptional({
    description: 'Optional milestone of the same project',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  milestoneId?: string;

  @ApiPropertyOptional({ enum: TaskStatus, default: TaskStatus.TODO })
  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  @ApiPropertyOptional({ enum: Priority, default: Priority.MEDIUM })
  @IsOptional()
  @IsEnum(Priority)
  priority?: Priority;

  @ApiPropertyOptional({
    example: '2026-11-15T21:00:00.000Z',
    description: 'ISO 8601 date/time',
  })
  @IsOptional()
  @IsDateString()
  dueDate?: string;
}
