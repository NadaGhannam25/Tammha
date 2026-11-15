import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { UploadedDocumentFile } from '@modules/documents/document-files';
import { AdminHandbookViewDto, HandbookViewDto } from '../dto/handbook.dto';
import { HandbookLibraryService } from '../library/handbook-library.service';

export {
  HANDBOOK_FOLDER,
  MIN_HANDBOOK_TEXT_CHARS,
} from '../library/handbook-library.service';

const err = (code: string, message: string) => ({ code, message });

/**
 * The university's official handbook (P13), now the DEFAULT handbook of the university
 * in the handbook library (University -> College -> Major -> Handbook -> Version).
 * Kept for the admin endpoints /admin/universities/:id/handbook and `npm run handbook`:
 * uploading adds a new current version of the default handbook (older versions stay as
 * history; versions used by a project are never deleted). The AI falls back to it when a
 * project has no handbook of its own.
 */
@Injectable()
export class HandbookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly library: HandbookLibraryService,
  ) {}

  get maxFileBytes() {
    return this.library.maxFileBytes;
  }

  /** Adds a new current version to the university's default handbook (created if needed). */
  async upsert(input: {
    universityId: string;
    title: string;
    description?: string | null;
    file: UploadedDocumentFile | undefined;
    uploadedById: string | null;
  }): Promise<AdminHandbookViewDto> {
    const university = await this.prisma.university.findUnique({
      where: { id: input.universityId },
      select: { id: true },
    });
    if (!university) {
      throw new NotFoundException(
        err('UNIVERSITY_NOT_FOUND', 'University not found'),
      );
    }
    // validate before creating anything
    await this.library.validatePdf(input.file);
    let handbook = await this.library.findUniversityDefault(input.universityId);
    if (!handbook) {
      const created = await this.library.createHandbook({
        universityId: input.universityId,
        title: input.title,
        description: input.description ?? undefined,
        isUniversityDefault: true,
      });
      handbook = {
        id: created.id,
        title: created.title,
        description: created.description,
      };
    } else {
      await this.library.updateHandbook(handbook.id, {
        title: input.title,
        description: input.description ?? '',
      });
    }
    await this.library.addVersion({
      handbookId: handbook.id,
      file: input.file,
      makeCurrent: true,
      uploadedById: input.uploadedById,
    });
    return this.adminView(input.universityId);
  }

  /** Deletes the university's default handbook (409 when a project uses one of its versions). */
  async remove(universityId: string): Promise<{ deleted: true }> {
    const handbook = await this.library.findUniversityDefault(universityId);
    if (!handbook) throw this.notFound();
    return this.library.deleteHandbook(handbook.id);
  }

  async adminView(universityId: string): Promise<AdminHandbookViewDto> {
    const row = await this.library.currentDefaultVersion(universityId);
    if (!row) throw this.notFound();
    const university = await this.prisma.university.findUnique({
      where: { id: universityId },
      select: { name: true },
    });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { extractedText, fileUrl, ...rest } = row;
    return {
      ...rest,
      universityName: university?.name ?? '',
      textPreview: (extractedText ?? '').replace(/\f/g, '\n').slice(0, 500),
    };
  }

  /** Every library version (metadata), newest first. */
  async list(): Promise<AdminHandbookViewDto[]> {
    const rows = await this.prisma.universityHandbook.findMany({
      select: {
        id: true,
        universityId: true,
        title: true,
        description: true,
        fileName: true,
        fileSize: true,
        pageCount: true,
        extractedChars: true,
        uploadedAt: true,
        updatedAt: true,
        uploadedById: true,
        university: { select: { name: true } },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    });
    return rows.map(({ university, ...rest }) => ({
      ...rest,
      universityName: university.name,
      textPreview: '',
    }));
  }

  /** Default handbook (current version, with text) of a university, for AI context. */
  async findForUniversity(universityId: string | null) {
    const row = await this.library.currentDefaultVersion(universityId);
    if (!row) return null;
    return {
      id: row.id,
      universityId: row.universityId,
      title: row.title,
      description: row.description,
      fileName: row.fileName,
      fileSize: row.fileSize,
      pageCount: row.pageCount,
      extractedChars: row.extractedChars,
      uploadedAt: row.uploadedAt,
      updatedAt: row.updatedAt,
      extractedText: row.extractedText,
    };
  }

  /** Metadata only (for students/supervisors). */
  async summaryForUniversity(
    universityId: string | null,
  ): Promise<HandbookViewDto | null> {
    const row = await this.findForUniversity(universityId);
    if (!row) return null;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { extractedText, ...rest } = row;
    return rest;
  }

  private notFound() {
    return new NotFoundException(
      err('HANDBOOK_NOT_FOUND', 'This university has no official handbook yet'),
    );
  }
}
