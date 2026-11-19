import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Trim } from '@common/utils/trim.transform';

export class UploadHandbookDto {
  @ApiProperty({
    minLength: 3,
    maxLength: 200,
    example: 'Graduation Project Handbook 2026-2027',
  })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  description?: string;
}

export class HandbookViewDto {
  @ApiProperty({ description: 'Id of the current version' }) id!: string;
  @ApiProperty() universityId!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty() fileName!: string;
  @ApiProperty({ description: 'bytes' }) fileSize!: number;
  @ApiProperty({ nullable: true, type: Number }) pageCount!: number | null;
  @ApiProperty({
    description: 'Characters of extracted text available to the AI',
  })
  extractedChars!: number;
  @ApiProperty() uploadedAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class AdminHandbookViewDto extends HandbookViewDto {
  @ApiProperty() universityName!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Admin who uploaded it (null = CLI)',
  })
  uploadedById!: string | null;
  @ApiProperty({
    description:
      'First 500 characters of the extracted text (to verify extraction)',
  })
  textPreview!: string;
}

/** What students/supervisors may see: metadata only, never the file or the text. */
export class ProjectHandbookDto {
  @ApiProperty({
    description: 'false when no READY handbook is selected for the project',
  })
  available!: boolean;
  @ApiProperty({
    enum: ['LIBRARY', 'PROJECT'],
    nullable: true,
    type: String,
    description:
      "Which handbook the AI uses: the university handbook selected for the project (LIBRARY) or the project's own upload (PROJECT); null when none is selected",
  })
  source!: 'LIBRARY' | 'PROJECT' | null;
  @ApiProperty({ nullable: true, type: String }) title!: string | null;
  @ApiProperty({ nullable: true, type: Number }) pageCount!: number | null;
  @ApiProperty({ nullable: true, type: Date }) updatedAt!: Date | null;
}

// ==========================================================
// P16: Project Handbook (uploaded by the team leader, belongs to a project)
// ==========================================================

export const PROJECT_HANDBOOK_STATES = [
  'NONE',
  'PROCESSING',
  'READY',
  'FAILED',
] as const;
export type ProjectHandbookState = (typeof PROJECT_HANDBOOK_STATES)[number];

export class UploadProjectHandbookDto {
  @ApiPropertyOptional({
    minLength: 3,
    maxLength: 200,
    example: 'Graduation Project Handbook 2026-2027',
    description: 'Defaults to the file name',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title?: string;
}

export class ProjectHandbookVersionDto {
  @ApiProperty() id!: string;
  @ApiProperty({ description: '1, 2, 3 ... (each upload is a new version)' })
  version!: number;
  @ApiProperty({ enum: ['PROCESSING', 'READY', 'FAILED'] }) status!: string;
  @ApiProperty({
    description: 'The version the AI uses (latest READY upload)',
  })
  isActive!: boolean;
  @ApiProperty() title!: string;
  @ApiProperty() fileName!: string;
  @ApiProperty({ description: 'bytes' }) fileSize!: number;
  @ApiProperty({ nullable: true, type: Number }) pageCount!: number | null;
  @ApiProperty({ description: 'Characters of extracted text' })
  extractedChars!: number;
  @ApiProperty({ description: 'Sections detected for AI retrieval' })
  sectionCount!: number;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'FAILED only: HANDBOOK_UNREADABLE | HANDBOOK_NO_TEXT | HANDBOOK_PROCESSING_INTERRUPTED | HANDBOOK_STORAGE_FAILED',
  })
  errorCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) errorMessage!: string | null;
  @ApiProperty({ nullable: true, type: Object })
  uploadedBy!: { id: string; firstName: string; lastName: string } | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ nullable: true, type: Date }) processedAt!: Date | null;
}

export class ProjectLibraryVersionRefDto {
  @ApiProperty() id!: string;
  @ApiProperty() handbookId!: string;
  @ApiProperty() title!: string;
  @ApiProperty() versionLabel!: string;
  @ApiProperty({ description: 'Real file name of the official PDF' })
  fileName!: string;
  @ApiProperty() universityId!: string;
  @ApiProperty() universityName!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Handbook university key (almaarefa, najran, pnu, tabuk); null for an older selection of another university',
  })
  universityKey!: string | null;
  @ApiProperty({ nullable: true, type: Number }) pageCount!: number | null;
}

export class ProjectHandbookStateDto {
  @ApiProperty({
    enum: PROJECT_HANDBOOK_STATES,
    description:
      'State of the APPLICABLE handbook. With source LIBRARY: READY (selected version available) or NONE. ' +
      'With source UPLOAD: NONE nothing uploaded, PROCESSING latest upload is being read, READY an active ' +
      'upload is available, FAILED latest upload failed (a previous READY version, if any, stays active).',
  })
  state!: ProjectHandbookState;
  @ApiProperty({
    enum: ['UPLOAD', 'LIBRARY'],
    description:
      "LIBRARY: a university's official handbook selected for the project. UPLOAD: the PDF uploaded by the leader",
  })
  source!: 'UPLOAD' | 'LIBRARY';
  @ApiProperty({ type: ProjectLibraryVersionRefDto, nullable: true })
  libraryVersion!: ProjectLibraryVersionRefDto | null;
  @ApiProperty({ type: ProjectHandbookVersionDto, nullable: true })
  active!: ProjectHandbookVersionDto | null;
  @ApiProperty({ type: ProjectHandbookVersionDto, nullable: true })
  latest!: ProjectHandbookVersionDto | null;
  @ApiProperty({ description: 'true for the team leader' })
  canUpload!: boolean;
  @ApiProperty({
    description: "true for the team leader (select a university's handbook)",
  })
  canSelect!: boolean;
  @ApiProperty({
    description:
      "true when the team's own university has an official handbook that can be selected (never used automatically)",
  })
  myUniversityHandbookAvailable!: boolean;
}

export class HandbookFileUrlDto {
  @ApiProperty({ description: 'Short-lived signed URL of the PDF' })
  url!: string;
  @ApiProperty() fileName!: string;
}
