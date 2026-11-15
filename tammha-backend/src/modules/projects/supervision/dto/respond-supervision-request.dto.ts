import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Trim } from '@common/utils/trim.transform';

export class RespondSupervisionRequestDto {
  @ApiPropertyOptional({
    example: 'Happy to supervise. Let us meet on Sunday.',
    maxLength: 1000,
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
