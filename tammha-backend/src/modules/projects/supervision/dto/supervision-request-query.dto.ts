import { ApiPropertyOptional } from '@nestjs/swagger';
import { SupervisionRequestStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

export class SupervisionRequestQueryDto {
  @ApiPropertyOptional({
    enum: SupervisionRequestStatus,
    description: 'Filter by status',
  })
  @IsOptional()
  @IsEnum(SupervisionRequestStatus)
  status?: SupervisionRequestStatus;
}
