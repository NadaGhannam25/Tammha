import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Trim } from '@common/utils/trim.transform';

export class UpdateTeamDto {
  @ApiPropertyOptional({ example: 'Tammha Team', minLength: 2, maxLength: 100 })
  @IsOptional()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    example: 'Graduation project team',
    maxLength: 1000,
    nullable: true,
    description: 'Send null to clear the description',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  description?: string | null;
}
