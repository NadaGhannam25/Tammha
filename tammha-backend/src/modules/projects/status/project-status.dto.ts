import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProjectStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { Trim } from '@common/utils/trim.transform';

export class UpdateProjectStatusDto {
  @ApiProperty({ enum: ProjectStatus })
  @IsEnum(ProjectStatus)
  status!: ProjectStatus;

  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Optional note included in the notification',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ProjectStatusChangeDto {
  @ApiProperty() projectId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ProjectStatus }) previousStatus!: ProjectStatus;
  @ApiProperty({ enum: ProjectStatus }) status!: ProjectStatus;
  @ApiProperty() changedAt!: Date;
}
