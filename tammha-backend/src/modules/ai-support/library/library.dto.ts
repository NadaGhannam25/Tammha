import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Trim } from '@common/utils/trim.transform';
import { HANDBOOK_UNIVERSITY_KEYS } from './handbook-universities';

// ==========================================================
// Official university handbooks (student-facing)
// ==========================================================

export class OfficialHandbookDto {
  @ApiProperty({
    description: 'Id of this handbook version (used by the project selection)',
  })
  versionId!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ description: 'Real file name of the uploaded PDF' })
  fileName!: string;
  @ApiProperty({ description: 'bytes' }) fileSize!: number;
  @ApiProperty({ nullable: true, type: Number }) pageCount!: number | null;
  @ApiProperty() uploadedAt!: Date;
  @ApiProperty({
    description:
      'Year the handbook was released (from the version label, else the upload year)',
    example: 2024,
  })
  releaseYear!: number;
}

export class HandbookUniversityNameDto {
  @ApiProperty({ example: 'Almaarefa University' }) en!: string;
  @ApiProperty({ example: 'جامعة المعرفة' }) ar!: string;
}

export class UniversityHandbookOptionDto {
  @ApiProperty({
    enum: HANDBOOK_UNIVERSITY_KEYS,
    description: 'Stable key shared with the frontend (handbooks-data.js)',
  })
  key!: string;
  @ApiProperty({ example: 'UM' }) code!: string;
  @ApiProperty({ type: HandbookUniversityNameDto })
  name!: HandbookUniversityNameDto;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Database id; null while the university is not set up yet',
  })
  universityId!: string | null;
  @ApiProperty({ description: "true for the signed-in user's own university" })
  isMyUniversity!: boolean;
  @ApiProperty({
    type: OfficialHandbookDto,
    nullable: true,
    description:
      'null = no official PDF uploaded yet (UI: "الدليل غير متاح حاليًا" / "Handbook not available")',
  })
  handbook!: OfficialHandbookDto | null;
}

// ==========================================================
// Version views (admin + project handbook state)
// ==========================================================

export class LibraryVersionDto {
  @ApiProperty() id!: string;
  @ApiProperty() handbookId!: string;
  @ApiProperty({ description: '1, 2, 3 ...' }) version!: number;
  @ApiProperty({ example: '2026-2027' }) versionLabel!: string;
  @ApiProperty({ description: 'The version shown by default' })
  isCurrent!: boolean;
  @ApiProperty() fileName!: string;
  @ApiProperty({ description: 'bytes' }) fileSize!: number;
  @ApiProperty({ nullable: true, type: Number }) pageCount!: number | null;
  @ApiProperty() uploadedAt!: Date;
  @ApiProperty({
    type: [String],
    description: 'Languages with a ready AI explanation (ar / en)',
  })
  explanations!: string[];
}

export class LibraryHandbookDto {
  @ApiProperty() id!: string;
  @ApiProperty() universityId!: string;
  @ApiProperty() universityName!: string;
  @ApiProperty({ nullable: true, type: String }) collegeId!: string | null;
  @ApiProperty({ nullable: true, type: String }) collegeName!: string | null;
  @ApiProperty({ nullable: true, type: String }) majorId!: string | null;
  @ApiProperty({ nullable: true, type: String }) majorName!: string | null;
  @ApiProperty({
    enum: ['UNIVERSITY', 'COLLEGE', 'MAJOR'],
    description: 'Who the handbook applies to',
  })
  scope!: 'UNIVERSITY' | 'COLLEGE' | 'MAJOR';
  @ApiProperty() title!: string;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty() isUniversityDefault!: boolean;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({ type: LibraryVersionDto, nullable: true })
  currentVersion!: LibraryVersionDto | null;
  @ApiProperty() versionCount!: number;
}

export class LibraryHandbookDetailDto extends LibraryHandbookDto {
  @ApiProperty({ type: [LibraryVersionDto], description: 'Newest first' })
  versions!: LibraryVersionDto[];
}

export class LibraryVersionDetailDto extends LibraryVersionDto {
  @ApiProperty({ type: LibraryHandbookDto }) handbook!: LibraryHandbookDto;
}

// ==========================================================
// Admin
// ==========================================================

// ==========================================================
// Admin
// ==========================================================

export class CreateLibraryHandbookDto {
  @ApiProperty() @IsString() @IsNotEmpty() universityId!: string;

  @ApiProperty({
    minLength: 3,
    maxLength: 200,
    example: 'Graduation Project Handbook',
  })
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({
    description:
      "The university's default handbook (whole university only; used by the AI when a project selected none)",
  })
  @IsOptional()
  @IsBoolean()
  isUniversityDefault?: boolean;
}

export class UpdateLibraryHandbookDto {
  @ApiPropertyOptional({ minLength: 3, maxLength: 200 })
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ maxLength: 1000, nullable: true })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isUniversityDefault?: boolean;
}

// ==========================================================
// Project selection
// ==========================================================

export class SelectUniversityHandbookDto {
  @ApiProperty({
    enum: HANDBOOK_UNIVERSITY_KEYS,
    example: 'almaarefa',
    description:
      "One of the four handbook universities. Choosing any of them never changes the student's registered university",
  })
  @IsIn(HANDBOOK_UNIVERSITY_KEYS)
  universityKey!: string;
}

export const EXPLANATION_LANGUAGES = ['ar', 'en'] as const;
