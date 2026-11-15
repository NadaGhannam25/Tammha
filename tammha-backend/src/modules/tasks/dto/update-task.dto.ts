import { ApiPropertyOptional } from '@nestjs/swagger';
import { Priority, TaskStatus } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Trim } from '@common/utils/trim.transform';

/**
 * All fields optional. Send null to clear description, assignedStudentId,
 * milestoneId or dueDate. projectId cannot be changed.
 * completedAt is managed by the server from the status.
 */
export class UpdateTaskDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 200 })
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ maxLength: 5000, nullable: true })
  @ValidateIf((_, v) => v !== null)
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(5000)
  description?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'null = unassign' })
  @ValidateIf((_, v) => v !== null)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  assignedStudentId?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'null = detach from milestone',
  })
  @ValidateIf((_, v) => v !== null)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  milestoneId?: string | null;

  @ApiPropertyOptional({
    enum: TaskStatus,
    description: 'COMPLETED sets completedAt; leaving COMPLETED clears it',
  })
  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  @ApiPropertyOptional({ enum: Priority })
  @IsOptional()
  @IsEnum(Priority)
  priority?: Priority;

  @ApiPropertyOptional({ nullable: true, example: '2026-11-15T21:00:00.000Z' })
  @ValidateIf((_, v) => v !== null)
  @IsOptional()
  @IsDateString()
  dueDate?: string | null;
}
