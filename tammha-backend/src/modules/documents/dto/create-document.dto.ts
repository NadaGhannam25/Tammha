import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DocumentCategory } from '@prisma/client';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Trim } from '@common/utils/trim.transform';

export class CreateDocumentDto {
  @ApiProperty({ example: 'Chapter 3 — System Design', maxLength: 200 })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({
    enum: DocumentCategory,
    default: DocumentCategory.GENERAL,
  })
  @IsOptional()
  @IsEnum(DocumentCategory)
  category?: DocumentCategory;
}
