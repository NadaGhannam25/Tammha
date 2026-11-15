import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
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
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '@modules/auth/guards/roles.guard';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { AuthUser } from '@common/types/auth-user.type';
import { UploadedDocumentFile } from '@modules/documents/document-files';
import { HandbookService } from './handbook.service';
import { AdminHandbookViewDto, UploadHandbookDto } from '../dto/handbook.dto';

/** Hard ceiling for multer; the configured HANDBOOK_MAX_FILE_MB (default 20) is enforced by the service. */
const MULTER_CEILING_BYTES = 50 * 1024 * 1024; // multer >= 2.3: maximum allowed size

@Controller('admin')
@ApiTags('Admin - Handbooks')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles([UserRole.ADMIN])
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
@ApiResponse({ status: 403, description: 'ADMIN only' })
export class HandbookAdminController {
  constructor(private readonly handbooks: HandbookService) {}

  @Get('handbooks')
  @ApiOperation({ summary: 'List all university handbooks (metadata)' })
  @ApiOkResponse({ type: [AdminHandbookViewDto] })
  list() {
    return this.handbooks.list();
  }

  @Get('universities/:universityId/handbook')
  @ApiOperation({
    summary: "A university's handbook (metadata + 500-character text preview)",
  })
  @ApiOkResponse({ type: AdminHandbookViewDto })
  @ApiResponse({ status: 404, description: 'HANDBOOK_NOT_FOUND' })
  get(@Param('universityId') universityId: string) {
    return this.handbooks.adminView(universityId);
  }

  @Put('universities/:universityId/handbook')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        ...MULTIPART_FIELD_LIMITS,
        fileSize: MULTER_CEILING_BYTES,
        files: 1,
      },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: "Upload or replace a university's official handbook (PDF)",
    description:
      'One handbook per university: uploading again replaces it (the old file is deleted). ' +
      'Text-based PDF only (max HANDBOOK_MAX_FILE_MB, default 20 MB); the text is extracted on upload. ' +
      'Stored privately in the existing Supabase bucket under handbooks/<universityId>/.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['title', 'file'],
      properties: {
        title: { type: 'string', maxLength: 200 },
        description: { type: 'string', maxLength: 1000 },
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiOkResponse({ type: AdminHandbookViewDto })
  @ApiResponse({
    status: 400,
    description:
      'Validation error, FILE_REQUIRED, FILE_EMPTY or HANDBOOK_NOT_PDF',
  })
  @ApiResponse({ status: 404, description: 'UNIVERSITY_NOT_FOUND' })
  @ApiResponse({ status: 413, description: 'FILE_TOO_LARGE' })
  @ApiResponse({
    status: 422,
    description: 'HANDBOOK_UNREADABLE or HANDBOOK_NO_TEXT (scanned PDF)',
  })
  @ApiResponse({ status: 503, description: 'STORAGE_ERROR' })
  upload(
    @CurrentUser() user: AuthUser,
    @Param('universityId') universityId: string,
    @Body() dto: UploadHandbookDto,
    @UploadedFile() file: UploadedDocumentFile | undefined,
  ) {
    return this.handbooks.upsert({
      universityId,
      title: dto.title,
      description: dto.description,
      file,
      uploadedById: user.id,
    });
  }

  @Delete('universities/:universityId/handbook')
  @ApiOperation({
    summary: "Delete a university's handbook (row and stored file)",
  })
  @ApiOkResponse({
    schema: { type: 'object', properties: { deleted: { type: 'boolean' } } },
  })
  @ApiResponse({ status: 404, description: 'HANDBOOK_NOT_FOUND' })
  remove(@Param('universityId') universityId: string) {
    return this.handbooks.remove(universityId);
  }
}
