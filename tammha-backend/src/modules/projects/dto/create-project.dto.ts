import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
 * Creates the project workspace. The creator becomes the team LEADER and the project
 * starts in setup (setupStep TEAM) until POST /projects/:id/setup/complete.
 */
export class CreateProjectDto extends ProjectDetailsDto {
  @ApiProperty({
    example: 'Tammha — Graduation Project Management Platform',
    minLength: 3,
    maxLength: 150,
  })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(150)
  name!: string;

  @ApiPropertyOptional({
    example:
      'Web platform that helps students and supervisors manage graduation projects',
    maxLength: 2000,
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({
    example: 'Team Tammha',
    minLength: 2,
    maxLength: 100,
    description: 'Defaults to "<project name> Team"',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  teamName?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  teamDescription?: string;

  @ApiPropertyOptional({ example: '2026-09-01', description: 'ISO 8601 date' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({
    example: '2027-05-30',
    description: 'ISO 8601 date; must not be before startDate',
  })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}
