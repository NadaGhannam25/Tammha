import { ApiProperty } from '@nestjs/swagger';
import { DocumentCategory, SubmissionStatus } from '@prisma/client';
import { PublicUserDto } from '@modules/teams/dto/team-response.dto';

export class DocumentViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty() projectId!: string;
  @ApiProperty({ enum: DocumentCategory }) category!: DocumentCategory;
  @ApiProperty({
    description:
      'Storage path of the CURRENT version (not a URL; the bucket is private)',
  })
  fileUrl!: string;
  @ApiProperty({
    description:
      'Original file name of the current version (Unicode/Arabic preserved)',
  })
  fileName!: string;
  @ApiProperty({ example: 'application/pdf' }) fileType!: string;
  @ApiProperty({ description: 'Bytes' }) fileSize!: number;
  @ApiProperty({ description: 'Always false: documents are private' })
  isPublic!: boolean;
  @ApiProperty({
    enum: SubmissionStatus,
    description:
      'Submission status. A new upload or version = SUBMITTED; the supervisor decides the rest.',
  })
  reviewStatus!: SubmissionStatus;
  @ApiProperty({ nullable: true, type: Date })
  reviewStatusUpdatedAt!: Date | null;
  @ApiProperty() currentVersion!: number;
  @ApiProperty() versionCount!: number;
  @ApiProperty({ type: PublicUserDto }) uploadedBy!: PublicUserDto;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class DocumentDetailsDto extends DocumentViewDto {
  @ApiProperty({
    description: 'Temporary link to view the current file (valid 1 hour)',
  })
  signedUrl!: string;
  @ApiProperty({
    description: 'Same link, downloads with the original file name',
  })
  downloadUrl!: string;
  @ApiProperty() signedUrlExpiresAt!: Date;
}

export class DocumentVersionViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() documentId!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ description: 'Storage path of this version' })
  fileUrl!: string;
  @ApiProperty() fileName!: string;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ description: 'Temporary link (valid 1 hour)' })
  signedUrl!: string;
  @ApiProperty() downloadUrl!: string;
  @ApiProperty() signedUrlExpiresAt!: Date;
}
