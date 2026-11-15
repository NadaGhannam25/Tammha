import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  ProjectCategory,
  ProjectOrigin,
  ProjectSetupStep,
} from '@prisma/client';
import { Trim } from '@common/utils/trim.transform';

/** Trims each objective and drops empty ones. */
const CleanObjectives = () =>
  Transform(({ value }) =>
    Array.isArray(value)
      ? value
          .map((v) => (typeof v === 'string' ? v.trim() : v))
          .filter((v) => v !== '')
      : value,
  );

/**
 * P16: project details collected during setup and editable by the team leader.
 * Shared by create and update (update accepts null to clear a value).
 */
export class ProjectDetailsDto {
  @ApiPropertyOptional({
    maxLength: 5000,
    nullable: true,
    description: 'Project overview shown at the top of the project page',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(5000)
  overview?: string | null;

  @ApiPropertyOptional({
    type: [String],
    maxItems: 10,
    example: ['Build the MVP', 'Evaluate with 30 students'],
    description: 'Up to 10 objectives, 300 characters each',
  })
  @IsOptional()
  @CleanObjectives()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  objectives?: string[];

  @ApiPropertyOptional({ enum: ProjectCategory, nullable: true })
  @IsOptional()
  @IsEnum(ProjectCategory)
  category?: ProjectCategory | null;

  @ApiPropertyOptional({
    enum: ProjectOrigin,
    nullable: true,
    description:
      'NEW idea, CONTINUATION of previous work, or PREVIOUSLY_IMPLEMENTED (re-implementation)',
  })
  @IsOptional()
  @IsEnum(ProjectOrigin)
  origin?: ProjectOrigin | null;

  @ApiPropertyOptional({
    example: '2027-05-15',
    nullable: true,
    description:
      "The team's expected completion date (endDate stays the official deadline)",
  })
  @IsOptional()
  @IsDateString()
  expectedCompletionDate?: string | null;
}

/** Steps the leader can move between while setup is not completed. */
export const OPEN_SETUP_STEPS = [
  ProjectSetupStep.TEAM,
  ProjectSetupStep.SUPERVISOR,
  ProjectSetupStep.DETAILS,
  ProjectSetupStep.QUESTIONS,
  ProjectSetupStep.HANDBOOK,
] as const;

export class UpdateSetupStepDto {
  @ApiProperty({
    enum: OPEN_SETUP_STEPS,
    description:
      'The wizard screen the leader is on (TEAM, SUPERVISOR, DETAILS, QUESTIONS, HANDBOOK). Use POST /projects/:id/setup/complete to finish.',
  })
  @IsNotEmpty()
  @IsIn(OPEN_SETUP_STEPS)
  step!: (typeof OPEN_SETUP_STEPS)[number];
}

export class ProjectSetupStateDto {
  @ApiProperty({ example: false }) completed!: boolean;
  @ApiProperty({ enum: ProjectSetupStep }) step!: ProjectSetupStep;
  @ApiProperty({ nullable: true, type: Date }) completedAt!: Date | null;
}
