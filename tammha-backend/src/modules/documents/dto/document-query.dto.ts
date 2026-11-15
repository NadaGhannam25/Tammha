import { ApiPropertyOptional } from '@nestjs/swagger';
import { SubmissionStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class DocumentQueryDto {
  @ApiPropertyOptional({ description: 'Limit to one accessible project' })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({
    enum: SubmissionStatus,
    description: 'Filter by submission status',
  })
  @IsOptional()
  @IsEnum(SubmissionStatus)
  status?: SubmissionStatus;
}
