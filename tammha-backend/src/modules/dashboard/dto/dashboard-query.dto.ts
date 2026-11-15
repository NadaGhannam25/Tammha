import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class DashboardQueryDto {
  @ApiPropertyOptional({
    description: 'Upcoming window in days (deadlines and meetings)',
    default: 14,
    minimum: 1,
    maximum: 90,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;

  @ApiPropertyOptional({
    description: 'Items per list (latest documents, feedback, submissions …)',
    default: 5,
    minimum: 1,
    maximum: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;

  @ApiPropertyOptional({
    description:
      'STUDENT: which of your projects to show (you can have several). Default: the most recently joined.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  projectId?: string;
}
