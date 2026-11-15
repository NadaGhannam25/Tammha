import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Trim } from '@common/utils/trim.transform';
import { ProjectDetailsDto } from './project-details.dto';

/**
 * Project details the team LEADER can edit (status has its own endpoint).
 * Send null for description/dates/overview/category/origin to clear them.
 */
export class UpdateProjectDto extends ProjectDetailsDto {
  @ApiPropertyOptional({ minLength: 3, maxLength: 150 })
  @IsOptional()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(150)
  name?: string;

  @ApiPropertyOptional({ maxLength: 2000, nullable: true })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({ example: '2026-09-01', nullable: true })
  @IsOptional()
  @IsDateString()
  startDate?: string | null;

  @ApiPropertyOptional({ example: '2027-05-30', nullable: true })
  @IsOptional()
  @IsDateString()
  endDate?: string | null;
}
