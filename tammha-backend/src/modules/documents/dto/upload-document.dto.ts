import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { Trim } from '@common/utils/trim.transform';
import { CreateDocumentDto } from './create-document.dto';

/** Multipart text fields of POST /documents/upload (the file itself is the "file" part). */
export class UploadDocumentDto extends CreateDocumentDto {
  @ApiProperty({
    description: 'Your project (students of the project team only)',
  })
  @Trim()
  @IsString()
  @IsNotEmpty()
  projectId!: string;

  @ApiPropertyOptional({
    description:
      'Send this file to the project supervisor for review (status SUBMITTED). ' +
      'Default false: a regular project file (status UPLOADED), visible to the team at once.',
    default: false,
  })
  @IsOptional()
  @Transform(({ value }) => parseBool(value))
  @IsBoolean()
  submitForReview?: boolean;
}

/** Multipart text fields of POST /documents/:id/versions (optional). */
export class CreateVersionDto {
  @ApiPropertyOptional({
    description:
      'Send the new version for review. Without it, a regular file stays UPLOADED and a file ' +
      'already in the review workflow is resubmitted (SUBMITTED).',
    default: false,
  })
  @IsOptional()
  @Transform(({ value }) => parseBool(value))
  @IsBoolean()
  submitForReview?: boolean;
}

/** multipart fields arrive as text: "true" / "1" / "on" -> true */
function parseBool(value: unknown): unknown {
  if (typeof value === 'boolean' || value === undefined) return value;
  if (typeof value === 'string') {
    if (/^(true|1|on|yes)$/i.test(value.trim())) return true;
    if (/^(false|0|off|no|)$/i.test(value.trim())) return false;
  }
  return value;
}
