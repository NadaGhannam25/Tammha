import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { MULTIPART_FIELD_LIMITS } from '@common/security/multipart-limits';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { DocumentCategory, UserRole } from '@prisma/client';

import { CurrentUser } from '@common/decorators/current-user.decorator';
import { AuthUser } from '@common/types/auth-user.type';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '@modules/auth/guards/roles.guard';

import { UpdateDocumentDto } from './dto/update-document.dto';
import { CreateVersionDto, UploadDocumentDto } from './dto/upload-document.dto';
import { DocumentQueryDto } from './dto/document-query.dto';
import {
  DocumentDetailsDto,
  DocumentVersionViewDto,
  DocumentViewDto,
} from './dto/document-response.dto';
import { DocumentsService } from './documents.service';
import { MAX_FILE_SIZE_BYTES, UploadedDocumentFile } from './document-files';

/**
 * One file per request, kept in memory (never written to disk).
 * multer >= 2.3 treats `fileSize` as the maximum ALLOWED size (P14: multer pinned to
 * 2.4.0 for security fixes; older versions needed "+ 1"): exactly 25 MB passes,
 * anything larger is rejected with 413. assertAllowedFile re-checks <= 25 MB.
 */
const fileUpload = () =>
  FileInterceptor('file', {
    limits: {
      ...MULTIPART_FIELD_LIMITS,
      fileSize: MAX_FILE_SIZE_BYTES,
      files: 1,
    },
  });

const FILE_RULES =
  'Max 25 MB. Executables/installers are rejected (.exe, .msi, .bat, .cmd, .vbs, .jar, .apk, .dmg, ...). ' +
  'Files are stored in the PRIVATE bucket "project-documents"; the original file name (Arabic included) is kept.';

@Controller('documents')
@ApiTags('Documents')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles([UserRole.STUDENT, UserRole.SUPERVISOR])
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
@ApiResponse({
  status: 403,
  description: 'Role not allowed, or PROJECT_ACCESS_DENIED',
})
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post('upload')
  @Roles([UserRole.STUDENT])
  @UseInterceptors(fileUpload())
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Upload a new document to your project (students of the project team)',
    description: `Creates the document and version 1. ${FILE_RULES}`,
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['projectId', 'title', 'file'],
      properties: {
        projectId: { type: 'string' },
        title: { type: 'string', maxLength: 200 },
        description: { type: 'string', maxLength: 1000 },
        category: { type: 'string', enum: Object.values(DocumentCategory) },
        submitForReview: {
          type: 'boolean',
          default: false,
          description:
            'Send to the supervisor for review (default: a regular file)',
        },
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiCreatedResponse({ type: DocumentViewDto })
  @ApiResponse({
    status: 400,
    description:
      'Validation error, FILE_REQUIRED, FILE_EMPTY or FILE_TYPE_NOT_ALLOWED',
  })
  @ApiResponse({ status: 413, description: 'File larger than 25 MB' })
  @ApiResponse({
    status: 409,
    description:
      'STORAGE_QUOTA_EXCEEDED — the file would exceed YOUR storage quota (shared by all your projects). details: usedBytes, quotaBytes, remainingBytes, requestedBytes. Nothing is stored.',
  })
  @ApiResponse({ status: 503, description: 'STORAGE_ERROR' })
  upload(
    @CurrentUser() user: AuthUser,
    @Body() dto: UploadDocumentDto,
    @UploadedFile() file: UploadedDocumentFile | undefined,
  ) {
    return this.documentsService.upload(user, dto, file);
  }

  @Get()
  @ApiOperation({
    summary: 'List documents',
    description:
      'Students: their own project. Supervisors: projects they supervise. Newest changes first. ' +
      'Filter by projectId and/or submission status.',
  })
  @ApiOkResponse({ type: [DocumentViewDto] })
  findMany(@CurrentUser() user: AuthUser, @Query() query: DocumentQueryDto) {
    return this.documentsService.findMany(user, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a document with a temporary signed URL',
    description:
      'signedUrl opens the current file; downloadUrl downloads it with its original name. Valid 1 hour.',
  })
  @ApiOkResponse({ type: DocumentDetailsDto })
  @ApiResponse({ status: 404, description: 'DOCUMENT_NOT_FOUND' })
  @ApiResponse({ status: 503, description: 'STORAGE_ERROR' })
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.documentsService.findOne(user, id);
  }

  @Patch(':id')
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary: 'Update title, description or category (uploader or team leader)',
  })
  @ApiOkResponse({ type: DocumentViewDto })
  @ApiResponse({
    status: 403,
    description:
      'DOCUMENT_NOT_OWNER or PROJECT_ACCESS_DENIED (any student of the team manages the files)',
  })
  @ApiResponse({ status: 404, description: 'DOCUMENT_NOT_FOUND' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateDocumentDto,
  ) {
    return this.documentsService.update(user, id, dto);
  }

  @Get(':id/versions')
  @ApiOperation({
    summary: 'Version history (newest first) with temporary signed URLs',
  })
  @ApiOkResponse({ type: [DocumentVersionViewDto] })
  @ApiResponse({ status: 404, description: 'DOCUMENT_NOT_FOUND' })
  @ApiResponse({ status: 503, description: 'STORAGE_ERROR' })
  getVersions(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.documentsService.getVersions(user, id);
  }

  @Post(':id/versions')
  @Roles([UserRole.STUDENT])
  @UseInterceptors(fileUpload())
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload a new version (uploader or team leader)',
    description: `Older versions are kept. The new file becomes the current one. ${FILE_RULES}`,
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
        submitForReview: { type: 'boolean', default: false },
      },
    },
  })
  @ApiCreatedResponse({ type: DocumentViewDto })
  @ApiResponse({
    status: 400,
    description: 'FILE_REQUIRED, FILE_EMPTY or FILE_TYPE_NOT_ALLOWED',
  })
  @ApiResponse({ status: 404, description: 'DOCUMENT_NOT_FOUND' })
  @ApiResponse({ status: 413, description: 'File larger than 25 MB' })
  @ApiResponse({
    status: 409,
    description:
      'STORAGE_QUOTA_EXCEEDED — the file would exceed YOUR storage quota (shared by all your projects). details: usedBytes, quotaBytes, remainingBytes, requestedBytes. Nothing is stored.',
  })
  @ApiResponse({ status: 503, description: 'STORAGE_ERROR' })
  createVersion(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @UploadedFile() file: UploadedDocumentFile | undefined,
    @Body() dto: CreateVersionDto,
  ) {
    return this.documentsService.createVersion(user, id, file, {
      submitForReview: dto?.submitForReview,
    });
  }

  @Post(':id/submit-for-review')
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary:
      'Send a regular project file to the supervisor for review (uploader or team leader)',
    description:
      'UPLOADED -> SUBMITTED and the project supervisor is notified. A file already in review is returned unchanged.',
  })
  @ApiCreatedResponse({ type: DocumentViewDto })
  @ApiResponse({
    status: 403,
    description: 'DOCUMENT_NOT_OWNER or PROJECT_ACCESS_DENIED',
  })
  @ApiResponse({ status: 404, description: 'DOCUMENT_NOT_FOUND' })
  submitForReview(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.documentsService.submitForReview(user, id);
  }

  @Delete(':id')
  @Roles([UserRole.STUDENT])
  @ApiOperation({
    summary:
      'Delete a document, all its versions and their stored files (uploader or team leader)',
    description:
      'The document disappears at once. Storage space is released only after Supabase Storage ' +
      'confirms the files were removed; if that fails, `storage.status` is PENDING_DELETION, the ' +
      "files keep counting toward each uploader's storage, and the removal is retried automatically.",
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        storage: {
          type: 'object',
          description:
            'REMOVED = stored objects removed, space released. PENDING_DELETION = Supabase Storage ' +
            'could not remove them yet: they still count toward storage and are retried automatically.',
          properties: {
            status: { type: 'string', enum: ['REMOVED', 'PENDING_DELETION'] },
            pendingObjects: { type: 'number' },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 403,
    description:
      'DOCUMENT_NOT_OWNER (uploader or team leader only) or PROJECT_ACCESS_DENIED',
  })
  @ApiResponse({ status: 404, description: 'DOCUMENT_NOT_FOUND' })
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.documentsService.remove(user, id);
  }
}
