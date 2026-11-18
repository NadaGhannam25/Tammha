import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '@/prisma/prisma.service';
import { AuthUser } from '@common/types/auth-user.type';
import { SupabaseStorageService } from '@modules/documents/supabase-storage.service';
import {
  repairMultipartFileName,
  sanitizeDisplayFileName,
  UploadedDocumentFile,
} from '@modules/documents/document-files';
import { readAiSupportSettings } from '../ai-support.config';
import {
  extractPdfText,
  ExtractedHandbookText,
} from '../handbook/handbook-text';
import {
  HANDBOOK_UNIVERSITIES,
  HANDBOOK_UNIVERSITY_KEYS,
  handbookUniversity,
  matchesHandbookUniversity,
} from './handbook-universities';
import {
  CreateLibraryHandbookDto,
  LibraryHandbookDetailDto,
  LibraryHandbookDto,
  LibraryVersionDetailDto,
  LibraryVersionDto,
  OfficialHandbookDto,
  UniversityHandbookOptionDto,
  UpdateLibraryHandbookDto,
} from './library.dto';

/** Below this, the PDF is almost certainly scanned images (no text layer). */
export const MIN_HANDBOOK_TEXT_CHARS = 200;
export const HANDBOOK_FOLDER = 'handbooks';
/** Library PDFs: handbooks/library/<handbookId>/<uuid>.pdf (private bucket). */
export const LIBRARY_FOLDER = `${HANDBOOK_FOLDER}/library`;

const err = (code: string, message: string, details?: object) => ({
  code,
  message,
  ...(details && { details }),
});

const VERSION_SELECT = {
  id: true,
  handbookId: true,
  version: true,
  versionLabel: true,
  isCurrent: true,
  fileName: true,
  fileSize: true,
  pageCount: true,
  uploadedAt: true,
  explanations: { select: { language: true } },
} satisfies Prisma.UniversityHandbookSelect;
type VersionRow = Prisma.UniversityHandbookGetPayload<{
  select: typeof VERSION_SELECT;
}>;

const HANDBOOK_INCLUDE = {
  university: { select: { name: true } },
  college: { select: { name: true } },
  major: { select: { name: true } },
  versions: { select: VERSION_SELECT, orderBy: { version: 'desc' } },
} satisfies Prisma.LibraryHandbookInclude;
type HandbookRow = Prisma.LibraryHandbookGetPayload<{
  include: typeof HANDBOOK_INCLUDE;
}>;

/**
 * Official university handbooks (simplified handbook library).
 *
 * - Each university has ONE official handbook (LibraryHandbook with isUniversityDefault);
 *   an ADMIN uploads its PDF with PUT /admin/universities/:universityId/handbook. A new
 *   upload becomes the current version; older versions stay for projects that selected them.
 *   Every upload is validated (PDF signature, HANDBOOK_MAX_FILE_MB, text layer) and its text
 *   is extracted once, page by page; files stay in the PRIVATE bucket.
 * - Students pick one of the FOUR handbook universities (handbook-universities.ts) in a list
 *   (GET /handbooks/universities) and use its official handbook for one project, or upload
 *   their own PDF (ProjectHandbookService). Other universities are not offered. Choosing
 *   another university's handbook never changes anyone's registered university.
 * - The earlier College / Major / multi-handbook browsing was retired from the API. Its
 *   tables (colleges, majors, library_handbooks.collegeId / majorId) are kept unchanged so
 *   no existing data is lost; nothing reads them any more.
 */
@Injectable()
export class HandbookLibraryService {
  private readonly logger = new Logger('HandbookLibrary');
  readonly maxFileBytes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: SupabaseStorageService,
    config: ConfigService,
  ) {
    this.maxFileBytes =
      readAiSupportSettings({
        HANDBOOK_MAX_FILE_MB: config.get('HANDBOOK_MAX_FILE_MB'),
      }).settings.handbookMaxFileMb *
      1024 *
      1024;
  }

  // ==========================================================
  // University handbooks (student-facing)
  // ==========================================================

  /**
   * Database row of each of the four handbook universities (null when it was not created
   * yet), in the fixed order of HANDBOOK_UNIVERSITIES.
   */
  async resolveHandbookUniversities() {
    const rows = await this.prisma.university.findMany({
      where: { isActive: true },
      select: { id: true, name: true, code: true },
      take: 500,
    });
    return HANDBOOK_UNIVERSITIES.map((def) => ({
      def,
      row: rows.find((r) => matchesHandbookUniversity(def, r)) ?? null,
    }));
  }

  /** Database id of a handbook university, or null when it is not set up (unknown key -> 404). */
  async handbookUniversityId(key: string): Promise<string | null> {
    if (!handbookUniversity(key)) {
      throw new NotFoundException(
        err(
          'UNIVERSITY_NOT_IN_HANDBOOK_LIST',
          `Handbooks are offered for: ${HANDBOOK_UNIVERSITY_KEYS.join(', ')}`,
        ),
      );
    }
    const all = await this.resolveHandbookUniversities();
    return all.find((u) => u.def.key === key)?.row?.id ?? null;
  }

  /**
   * The four handbook universities (always all four, fixed order) with the real file name of
   * the OFFICIAL handbook (current version of the university's default handbook), or
   * handbook: null when no PDF was uploaded (UI: "الدليل غير متاح حاليًا"). Any signed-in user
   * can use any of them: this never changes a registered university.
   */
  async listHandbookOptions(
    user: AuthUser,
  ): Promise<UniversityHandbookOptionDto[]> {
    const all = await this.resolveHandbookUniversities();
    const options: UniversityHandbookOptionDto[] = [];
    for (const { def, row } of all) {
      const v = row ? await this.currentDefaultVersion(row.id) : null;
      options.push({
        key: def.key,
        code: def.code,
        name: { ar: def.name.ar, en: def.name.en },
        universityId: row?.id ?? null,
        isMyUniversity: !!row && row.id === user.universityId,
        handbook: v ? toOfficialView(v) : null,
      });
    }
    return options;
  }

  /** The official handbook of a handbook university (404 UNIVERSITY_HANDBOOK_NOT_AVAILABLE when none). */
  async officialHandbook(key: string) {
    const universityId = await this.handbookUniversityId(key);
    const v = universityId
      ? await this.currentDefaultVersion(universityId)
      : null;
    if (!v) {
      throw new NotFoundException(
        err(
          'UNIVERSITY_HANDBOOK_NOT_AVAILABLE',
          'No official handbook has been uploaded for this university yet',
        ),
      );
    }
    return v;
  }

  /** Signed URL of the official handbook PDF of a handbook university (any signed-in user). */
  async officialFileUrl(key: string) {
    const v = await this.officialHandbook(key);
    return {
      url: await this.storage.createSignedUrl(v.fileUrl),
      fileName: v.fileName,
    };
  }

  async getHandbook(
    handbookId: string,
    includeInactive = false,
  ): Promise<LibraryHandbookDetailDto> {
    const row = await this.prisma.libraryHandbook.findUnique({
      where: { id: handbookId },
      include: HANDBOOK_INCLUDE,
    });
    if (!row || (!includeInactive && !row.isActive)) throw handbookNotFound();
    return {
      ...this.toHandbookView(row),
      versions: [...row.versions]
        .sort((a, b) => b.version - a.version)
        .map(toVersionView),
    };
  }

  async getVersion(
    versionId: string,
    includeInactive = false,
  ): Promise<LibraryVersionDetailDto> {
    const version = await this.prisma.universityHandbook.findUnique({
      where: { id: versionId },
      select: VERSION_SELECT,
    });
    if (!version) throw versionNotFound();
    const handbook = await this.getHandbook(
      version.handbookId,
      includeInactive,
    );
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { versions, ...handbookView } = handbook;
    return { ...toVersionView(version), handbook: handbookView };
  }

  /** Short-lived signed URL of a version's PDF (any signed-in user). */
  async versionFileUrl(versionId: string) {
    const row = await this.prisma.universityHandbook.findUnique({
      where: { id: versionId },
      select: {
        fileUrl: true,
        fileName: true,
        handbook: { select: { isActive: true } },
      },
    });
    if (!row || !row.handbook.isActive) throw versionNotFound();
    return {
      url: await this.storage.createSignedUrl(row.fileUrl),
      fileName: row.fileName,
    };
  }

  /** Text of a version (AI explanation and guidance; never returned to users). */
  async versionText(versionId: string) {
    const row = await this.prisma.universityHandbook.findUnique({
      where: { id: versionId },
      select: {
        id: true,
        title: true,
        pageCount: true,
        extractedText: true,
        handbook: { select: { title: true, isActive: true } },
      },
    });
    if (!row) throw versionNotFound();
    return {
      id: row.id,
      title: row.handbook.title ?? row.title,
      pageCount: row.pageCount,
      extractedText: row.extractedText ?? '',
    };
  }

  // ==========================================================
  // Admin: official handbooks and versions
  // ==========================================================

  /**
   * Creates the official handbook record of a university (whole university, its default).
   * Colleges / majors are no longer used: each university has ONE official handbook,
   * and a new PDF becomes its new current version.
   */
  async createHandbook(
    dto: CreateLibraryHandbookDto,
  ): Promise<LibraryHandbookDetailDto> {
    await this.universityOrThrow(dto.universityId);
    const id = await this.prisma.$transaction(async (tx) => {
      if (dto.isUniversityDefault) {
        await tx.libraryHandbook.updateMany({
          where: { universityId: dto.universityId, isUniversityDefault: true },
          data: { isUniversityDefault: false },
        });
      }
      const row = await tx.libraryHandbook.create({
        data: {
          universityId: dto.universityId,
          title: dto.title,
          description: dto.description || null,
          isUniversityDefault: !!dto.isUniversityDefault,
        },
        select: { id: true },
      });
      return row.id;
    });
    return this.getHandbook(id, true);
  }

  async updateHandbook(
    handbookId: string,
    dto: UpdateLibraryHandbookDto,
  ): Promise<LibraryHandbookDetailDto> {
    const current = await this.prisma.libraryHandbook.findUnique({
      where: { id: handbookId },
      select: { id: true, universityId: true, collegeId: true },
    });
    if (!current) throw handbookNotFound();
    if (dto.isUniversityDefault && current.collegeId) {
      throw new BadRequestException(
        err(
          'DEFAULT_HANDBOOK_SCOPE',
          'Only a handbook for the whole university can be its default handbook',
        ),
      );
    }
    await this.prisma.$transaction(async (tx) => {
      if (dto.isUniversityDefault) {
        await tx.libraryHandbook.updateMany({
          where: {
            universityId: current.universityId,
            isUniversityDefault: true,
            id: { not: handbookId },
          },
          data: { isUniversityDefault: false },
        });
      }
      await tx.libraryHandbook.update({
        where: { id: handbookId },
        data: {
          ...(dto.title !== undefined && { title: dto.title }),
          ...(dto.description !== undefined && {
            description: dto.description || null,
          }),
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
          ...(dto.isUniversityDefault !== undefined && {
            isUniversityDefault: dto.isUniversityDefault,
          }),
        },
      });
    });
    return this.getHandbook(handbookId, true);
  }

  /**
   * Uploads a new version (validated PDF; text extracted now). It becomes the current
   * version unless makeCurrent is false. 202 is not needed: admin uploads are processed
   * synchronously (they are rare and small).
   */
  async addVersion(input: {
    handbookId: string;
    file: UploadedDocumentFile | undefined;
    versionLabel?: string;
    makeCurrent?: boolean;
    uploadedById: string | null;
  }): Promise<LibraryVersionDetailDto> {
    const handbook = await this.prisma.libraryHandbook.findUnique({
      where: { id: input.handbookId },
      select: { id: true, universityId: true, title: true, description: true },
    });
    if (!handbook) throw handbookNotFound();
    const { file, extracted, fileName } = await this.validatePdf(input.file);
    const path = `${LIBRARY_FOLDER}/${handbook.id}/${randomUUID()}.pdf`;
    const makeCurrent = input.makeCurrent ?? true;

    await this.storage.upload(path, file.buffer, 'application/pdf');
    let id: string;
    try {
      id = await this.prisma.$transaction(async (tx) => {
        // serialise uploads of one handbook (version numbers)
        await tx.libraryHandbook.update({
          where: { id: handbook.id },
          data: { updatedAt: new Date() },
        });
        const last = await tx.universityHandbook.findFirst({
          where: { handbookId: handbook.id },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        const version = (last?.version ?? 0) + 1;
        const isFirst = !last;
        if (makeCurrent || isFirst) {
          await tx.universityHandbook.updateMany({
            where: { handbookId: handbook.id, isCurrent: true },
            data: { isCurrent: false },
          });
        }
        const row = await tx.universityHandbook.create({
          data: {
            universityId: handbook.universityId,
            handbookId: handbook.id,
            version,
            versionLabel: input.versionLabel?.trim() || String(version),
            isCurrent: makeCurrent || isFirst,
            title: handbook.title,
            description: handbook.description,
            fileUrl: path,
            fileName,
            fileSize: file.size,
            contentType: 'application/pdf',
            pageCount: extracted.pageCount,
            extractedText: extracted.text,
            extractedChars: extracted.text.length,
            uploadedById: input.uploadedById,
          },
          select: { id: true },
        });
        return row.id;
      });
    } catch (error) {
      await this.removeQuietly(path);
      throw error;
    }
    this.logger.log(
      `library handbook ${handbook.id}: version ${id} saved (${extracted.pageCount} pages)`,
    );
    return this.getVersion(id, true);
  }

  /**
   * Deletes a version (row + file). A version selected by a project cannot be deleted
   * (409 HANDBOOK_VERSION_IN_USE): it would silently remove that project's handbook.
   */
  async deleteVersion(versionId: string): Promise<{ deleted: true }> {
    const row = await this.prisma.universityHandbook.findUnique({
      where: { id: versionId },
      select: { id: true, handbookId: true, isCurrent: true, fileUrl: true },
    });
    if (!row) throw versionNotFound();
    await this.assertNotInUse([row.id]);
    await this.prisma.$transaction(async (tx) => {
      await tx.universityHandbook.delete({ where: { id: row.id } });
      if (row.isCurrent) {
        const newest = await tx.universityHandbook.findFirst({
          where: { handbookId: row.handbookId },
          orderBy: { version: 'desc' },
          select: { id: true },
        });
        if (newest) {
          await tx.universityHandbook.update({
            where: { id: newest.id },
            data: { isCurrent: true },
          });
        }
      }
    });
    await this.removeQuietly(row.fileUrl);
    return { deleted: true };
  }

  /** Deletes a handbook with all its versions (none may be in use by a project). */
  async deleteHandbook(handbookId: string): Promise<{ deleted: true }> {
    const versions = await this.prisma.universityHandbook.findMany({
      where: { handbookId },
      select: { id: true, fileUrl: true },
    });
    const exists = await this.prisma.libraryHandbook.findUnique({
      where: { id: handbookId },
      select: { id: true },
    });
    if (!exists) throw handbookNotFound();
    await this.assertNotInUse(versions.map((v) => v.id));
    await this.prisma.$transaction([
      this.prisma.universityHandbook.deleteMany({ where: { handbookId } }),
      this.prisma.libraryHandbook.delete({ where: { id: handbookId } }),
    ]);
    for (const v of versions) await this.removeQuietly(v.fileUrl);
    return { deleted: true };
  }

  // ==========================================================
  // University default handbook (the P13 "university handbook")
  // ==========================================================

  /** The default library handbook of a university (or null). */
  findUniversityDefault(universityId: string) {
    return this.prisma.libraryHandbook.findFirst({
      where: { universityId, isUniversityDefault: true },
      select: { id: true, title: true, description: true },
    });
  }

  /** Current version of the university's default handbook (with text) or null. */
  async currentDefaultVersion(universityId: string | null) {
    if (!universityId) return null;
    const handbook = await this.prisma.libraryHandbook.findFirst({
      where: { universityId, isUniversityDefault: true, isActive: true },
      select: { id: true },
    });
    if (!handbook) return null;
    return this.prisma.universityHandbook.findFirst({
      where: { handbookId: handbook.id, isCurrent: true },
      select: {
        id: true,
        universityId: true,
        title: true,
        description: true,
        fileName: true,
        fileSize: true,
        pageCount: true,
        version: true,
        versionLabel: true,
        extractedChars: true,
        extractedText: true,
        uploadedAt: true,
        updatedAt: true,
        uploadedById: true,
        fileUrl: true,
      },
    });
  }

  // ==========================================================
  // Internals
  // ==========================================================

  async validatePdf(input: UploadedDocumentFile | undefined): Promise<{
    file: UploadedDocumentFile;
    extracted: ExtractedHandbookText;
    fileName: string;
  }> {
    const file = input;
    if (!file)
      throw new BadRequestException(
        err('FILE_REQUIRED', 'Attach the handbook PDF as "file"'),
      );
    if (!file.size || file.buffer.length === 0) {
      throw new BadRequestException(err('FILE_EMPTY', 'The file is empty'));
    }
    if (
      file.size > this.maxFileBytes ||
      file.buffer.length > this.maxFileBytes
    ) {
      throw new PayloadTooLargeException(
        err(
          'FILE_TOO_LARGE',
          `The handbook must be at most ${this.maxFileBytes / 1024 / 1024} MB`,
        ),
      );
    }
    if (file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new BadRequestException(
        err('HANDBOOK_NOT_PDF', 'The handbook must be a PDF file'),
      );
    }
    let extracted: ExtractedHandbookText;
    try {
      extracted = await extractPdfText(file.buffer);
    } catch (error) {
      this.logger.warn(
        `PDF extraction failed: ${(error as Error)?.name ?? 'Error'}`,
      );
      throw new UnprocessableEntityException(
        err(
          'HANDBOOK_UNREADABLE',
          'The PDF could not be read. Export it again as a standard PDF.',
        ),
      );
    }
    if (extracted.text.replace(/\s/g, '').length < MIN_HANDBOOK_TEXT_CHARS) {
      throw new UnprocessableEntityException(
        err(
          'HANDBOOK_NO_TEXT',
          'No text could be extracted (scanned PDF?). Upload a text-based PDF (e.g. exported from Word).',
        ),
      );
    }
    const fileName =
      sanitizeDisplayFileName(repairMultipartFileName(file.originalname)) ||
      'handbook.pdf';
    return { file, extracted, fileName };
  }

  private async assertNotInUse(versionIds: string[]) {
    if (versionIds.length === 0) return;
    const inUse = await this.prisma.project.count({
      where: { libraryHandbookId: { in: versionIds } },
    });
    if (inUse > 0) {
      throw new ConflictException(
        err(
          'HANDBOOK_VERSION_IN_USE',
          'Projects use this handbook version. Add a newer version instead; projects can then switch to it.',
          { projects: inUse },
        ),
      );
    }
  }

  private toHandbookView(r: HandbookRow): LibraryHandbookDto {
    const current =
      r.versions.find((v) => v.isCurrent) ?? r.versions[0] ?? null;
    return {
      id: r.id,
      universityId: r.universityId,
      universityName: r.university.name,
      collegeId: r.collegeId,
      collegeName: r.college?.name ?? null,
      majorId: r.majorId,
      majorName: r.major?.name ?? null,
      scope: r.majorId ? 'MAJOR' : r.collegeId ? 'COLLEGE' : 'UNIVERSITY',
      title: r.title,
      description: r.description,
      isUniversityDefault: r.isUniversityDefault,
      isActive: r.isActive,
      currentVersion: current ? toVersionView(current) : null,
      versionCount: r.versions.length,
    };
  }

  private async universityOrThrow(id: string) {
    const row = await this.prisma.university.findUnique({
      where: { id },
      select: { id: true, isActive: true },
    });
    if (!row || !row.isActive) {
      throw new NotFoundException(
        err('UNIVERSITY_NOT_FOUND', 'University not found'),
      );
    }
    return row;
  }

  async removeQuietly(path: string) {
    if (!path.startsWith(`${HANDBOOK_FOLDER}/`)) return; // never touch project documents
    try {
      await this.storage.remove([path]);
    } catch {
      this.logger.error(`could not remove handbook object ${path}`);
    }
  }
}

function toOfficialView(v: {
  id: string;
  title: string;
  fileName: string;
  fileSize: number;
  pageCount: number | null;
  uploadedAt: Date;
  versionLabel?: string | null;
}): OfficialHandbookDto {
  return {
    versionId: v.id,
    title: v.title,
    fileName: v.fileName,
    fileSize: v.fileSize,
    pageCount: v.pageCount,
    uploadedAt: v.uploadedAt,
    releaseYear: releaseYear(v.versionLabel, v.uploadedAt),
  };
}

/**
 * The year the handbook was released, shown as "Edition <year>": the year written in the
 * version label (e.g. "2024" or "2024-2025" -> 2024), otherwise the year it was added.
 */
export function releaseYear(
  label: string | null | undefined,
  uploadedAt: Date,
): number {
  const m = /(?:^|\D)((?:19|20)\d{2})(?!\d)/.exec(label ?? '');
  return m ? Number(m[1]) : new Date(uploadedAt).getUTCFullYear();
}

function toVersionView(v: VersionRow): LibraryVersionDto {
  return {
    id: v.id,
    handbookId: v.handbookId,
    version: v.version,
    versionLabel: v.versionLabel,
    isCurrent: v.isCurrent,
    fileName: v.fileName,
    fileSize: v.fileSize,
    pageCount: v.pageCount,
    uploadedAt: v.uploadedAt,
    explanations: (v.explanations ?? []).map((e) => e.language).sort(),
  };
}

function handbookNotFound() {
  return new NotFoundException(err('HANDBOOK_NOT_FOUND', 'Handbook not found'));
}

function versionNotFound() {
  return new NotFoundException(
    err('HANDBOOK_VERSION_NOT_FOUND', 'Handbook version not found'),
  );
}
