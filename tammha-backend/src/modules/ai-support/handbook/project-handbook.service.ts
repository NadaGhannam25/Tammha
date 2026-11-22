import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationShutdown,
  PayloadTooLargeException,
} from '@nestjs/common';
import {
  HandbookStatus,
  NotificationType,
  Prisma,
  StoredObjectKind,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '@/prisma/prisma.service';
import { AuthUser } from '@common/types/auth-user.type';
import { WorkspaceAccessService } from '@common/workspace/workspace-access.service';
import { SupabaseStorageService } from '@modules/documents/supabase-storage.service';
import {
  repairMultipartFileName,
  sanitizeDisplayFileName,
  UploadedDocumentFile,
} from '@modules/documents/document-files';
import { NotificationsService } from '@modules/notifications/notifications.service';
import { StorageQuotaService } from '@modules/storage/storage-quota.service';
import {
  StorageCleanupResult,
  StorageDeletionService,
} from '@modules/storage/storage-deletion.service';
import { extractPdfText } from './handbook-text';
import {
  HANDBOOK_PROCESSING_STALE_MS,
  loadEffectiveHandbook,
} from './handbook-state';
import { chunkHandbook } from './handbook-retrieval';
import {
  HANDBOOK_FOLDER,
  HandbookService,
  MIN_HANDBOOK_TEXT_CHARS,
} from './handbook.service';
import { HandbookLibraryService } from '../library/handbook-library.service';
import {
  HandbookFileUrlDto,
  ProjectHandbookStateDto,
  ProjectHandbookVersionDto,
} from '../dto/handbook.dto';

type Db = PrismaService | Prisma.TransactionClient;
type Uploader = { id: string; firstName: string; lastName: string };

export { HANDBOOK_PROCESSING_STALE_MS };

const ERROR_MESSAGES: Record<string, string> = {
  HANDBOOK_UNREADABLE:
    'The PDF could not be read. Export it again as a standard PDF and upload it again.',
  HANDBOOK_NO_TEXT:
    'No text could be extracted (scanned PDF?). Upload a text-based PDF (e.g. exported from Word).',
  HANDBOOK_PROCESSING_INTERRUPTED:
    'Processing was interrupted. Please upload the handbook again.',
  HANDBOOK_PROCESSING_FAILED:
    'The handbook could not be processed. Please upload it again.',
};

const err = (code: string, message: string) => ({ code, message });

const VERSION_SELECT = {
  id: true,
  projectId: true,
  version: true,
  status: true,
  isActive: true,
  title: true,
  fileName: true,
  fileSize: true,
  pageCount: true,
  extractedChars: true,
  sectionCount: true,
  errorCode: true,
  processingStartedAt: true,
  createdAt: true,
  processedAt: true,
  uploadedById: true,
} satisfies Prisma.ProjectHandbookSelect;
type VersionRow = Prisma.ProjectHandbookGetPayload<{
  select: typeof VERSION_SELECT;
}>;

/**
 * Project Handbook (P16): the handbook belongs to a project and is uploaded by its team
 * LEADER (first-project setup step "Handbook", or later from the project page).
 *
 * - Same validation, storage and text extraction as the university handbook (P13):
 *   PDF signature, HANDBOOK_MAX_FILE_MB, private bucket, text stored in the database.
 * - Every upload is a new version (1, 2, 3 ...). The upload answers 202 with status
 *   PROCESSING; the text is extracted in the background. On success the version becomes
 *   READY and active (previous versions are deactivated); on failure it is FAILED with a
 *   stable errorCode and the previous READY version stays active.
 * - Processing never calls the AI provider and never counts against the AI chat limits.
 * - Students and the supervisor of the project may read the state; the file is only
 *   available through a short-lived signed URL; the extracted text is never returned.
 */
@Injectable()
export class ProjectHandbookService implements OnApplicationShutdown {
  private readonly logger = new Logger('ProjectHandbooks');
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly storage: SupabaseStorageService,
    private readonly universityHandbooks: HandbookService,
    private readonly notifications: NotificationsService,
    private readonly quota: StorageQuotaService,
    private readonly deletions: StorageDeletionService,
    private readonly library: HandbookLibraryService,
  ) {}

  // ==========================================================
  // Upload (team leader)
  // ==========================================================

  async upload(
    user: AuthUser,
    projectId: string,
    input: { title?: string; file: UploadedDocumentFile | undefined },
  ): Promise<ProjectHandbookStateDto> {
    const project = await this.access.assertLeaderOfProject(user, projectId);
    const file = this.validateFile(input.file);
    const fileName =
      sanitizeDisplayFileName(repairMultipartFileName(file.originalname)) ||
      'handbook.pdf';
    const title =
      input.title?.trim() || fileName.replace(/\.pdf$/i, '').slice(0, 200);
    const path = `${HANDBOOK_FOLDER}/projects/${project.id}/${randomUUID()}.pdf`;

    // the stored PDF counts toward the uploader's storage quota (checked before storing)
    await this.quota.assertCanStore(user, file.size);
    await this.storage.upload(path, file.buffer, 'application/pdf');
    let created: { id: string };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        await this.quota.reserveInTransaction(user, file.size, tx);
        await this.lockProject(project.id, tx);
        // uploading means: this project uses its own PDF (not a library version)
        await tx.project.update({
          where: { id: project.id },
          data: { handbookSource: 'UPLOAD' },
        });
        const last = await tx.projectHandbook.findFirst({
          where: { projectId: project.id },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        return tx.projectHandbook.create({
          data: {
            projectId: project.id,
            version: (last?.version ?? 0) + 1,
            status: HandbookStatus.PROCESSING,
            title: title.length >= 3 ? title : 'Project handbook',
            fileName,
            fileSize: file.size,
            contentType: 'application/pdf',
            storagePath: path,
            uploadedById: user.id,
            processingStartedAt: new Date(),
          },
          select: { id: true },
        });
      });
    } catch (error) {
      // if Storage fails too, the PDF stays recorded (and counted) until it is removed
      await this.deletions.removeAfterFailedWrite({
        storagePath: path,
        kind: StoredObjectKind.PROJECT_HANDBOOK,
        fileSize: file.size,
        uploadedById: user.id,
        projectId: project.id,
        safeToDelete: isProjectHandbookPath(path, project.id),
      });
      throw error;
    }

    this.track(this.process(created.id, file.buffer));
    return this.state(user, project.id);
  }

  /**
   * Permanently deletes an old or failed handbook version (row + stored PDF). The active
   * version and a version still being processed cannot be deleted. Team leader only.
   *
   * The space is released only when Supabase confirms the PDF was removed: the row is
   * replaced by a pending deletion in one transaction (still counted), then the object is
   * removed. If Storage fails, `releasedBytes` is 0, `storage.status` is PENDING_DELETION
   * and the removal is retried in the background.
   */
  async deleteVersion(
    user: AuthUser,
    projectId: string,
    handbookId: string,
  ): Promise<{
    deleted: true;
    releasedBytes: number;
    storage: StorageCleanupResult;
  }> {
    const project = await this.access.assertLeaderOfProject(user, projectId);
    const row = await this.prisma.projectHandbook.findFirst({
      where: { id: handbookId, projectId: project.id },
      select: {
        id: true,
        isActive: true,
        status: true,
        storagePath: true,
        fileSize: true,
        uploadedById: true,
      },
    });
    if (!row) {
      throw new NotFoundException(
        err('HANDBOOK_NOT_FOUND', 'Handbook version not found in this project'),
      );
    }
    if (row.isActive) {
      throw new ConflictException(
        err(
          'HANDBOOK_ACTIVE_VERSION',
          'The active handbook cannot be deleted. Upload a new version first.',
        ),
      );
    }
    if (row.status === HandbookStatus.PROCESSING) {
      throw new ConflictException(
        err('HANDBOOK_PROCESSING', 'This version is still being processed'),
      );
    }
    // 1) row -> pending deletion in one transaction (the usage does not drop yet)
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.deletions.queue(tx, [
          {
            storagePath: row.storagePath,
            kind: StoredObjectKind.PROJECT_HANDBOOK,
            fileSize: row.fileSize,
            uploadedById: row.uploadedById,
            projectId: project.id,
            safeToDelete: isProjectHandbookPath(row.storagePath, project.id),
          },
        ]);
        await tx.projectHandbook.delete({ where: { id: row.id } });
      });
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'P2025') {
        throw new NotFoundException(
          err(
            'HANDBOOK_NOT_FOUND',
            'Handbook version not found in this project',
          ),
        );
      }
      throw error;
    }
    // 2) only a confirmed removal from Storage releases the space
    const storage = await this.deletions.removeNow([row.storagePath]);
    return {
      deleted: true,
      releasedBytes: storage.status === 'REMOVED' ? row.fileSize : 0,
      storage,
    };
  }

  // ==========================================================
  // Reads (project students + its supervisor)
  // ==========================================================

  async state(
    user: AuthUser,
    projectId: string,
  ): Promise<ProjectHandbookStateDto> {
    const project = await this.access.assertCanViewProject(user, projectId);
    await this.failStale(project.id);
    const [active, latest, canUpload, university, effective] =
      await Promise.all([
        this.prisma.projectHandbook.findFirst({
          where: { projectId: project.id, isActive: true },
          select: VERSION_SELECT,
        }),
        this.prisma.projectHandbook.findFirst({
          where: { projectId: project.id },
          orderBy: { version: 'desc' },
          select: VERSION_SELECT,
        }),
        // every student of the team uploads or selects the project handbook
        this.access
          .findMembershipInTeam(user.id, project.teamId)
          .then((m) => !!m),
        this.access
          .getTeamUniversityId(project.teamId)
          .then((id) => this.universityHandbooks.summaryForUniversity(id)),
        loadEffectiveHandbook(this.prisma, project.id),
      ]);
    const users = await this.uploaders([active, latest]);
    let libraryVersion = effective.libraryVersion
      ? { ...effective.libraryVersion, universityKey: null as string | null }
      : null;
    if (libraryVersion) {
      const all = await this.library.resolveHandbookUniversities();
      libraryVersion = {
        ...libraryVersion,
        universityKey:
          all.find((u) => u.row?.id === libraryVersion!.universityId)?.def
            .key ?? null,
      };
    }
    return {
      state: effective.state,
      source: effective.source,
      libraryVersion,
      active: active ? this.toView(active, users) : null,
      latest: latest ? this.toView(latest, users) : null,
      canUpload,
      canSelect: canUpload,
      myUniversityHandbookAvailable: !!university,
    };
  }

  // ==========================================================
  // University handbook selection (team leader)
  // ==========================================================

  /**
   * The project uses the CURRENT official handbook of a university (any university:
   * choosing another university's handbook never changes anyone's registered university).
   * The chosen version stays fixed for the project until it is selected again.
   * Uploaded versions are kept; uploading again switches back to the upload.
   */
  async selectUniversityHandbook(
    user: AuthUser,
    projectId: string,
    universityKey: string,
  ): Promise<ProjectHandbookStateDto> {
    const project = await this.access.assertLeaderOfProject(user, projectId);
    // only the four handbook universities (404 UNIVERSITY_NOT_IN_HANDBOOK_LIST otherwise)
    const universityId = await this.library.handbookUniversityId(universityKey);
    const version = universityId
      ? await this.universityHandbooks.findForUniversity(universityId)
      : null;
    if (!version) {
      throw new NotFoundException(
        err(
          'UNIVERSITY_HANDBOOK_NOT_AVAILABLE',
          'No official handbook has been uploaded for this university yet',
        ),
      );
    }
    if (!version.extractedText) {
      throw new ConflictException(
        err('HANDBOOK_NOT_READABLE', 'This handbook has no readable text'),
      );
    }
    await this.prisma.project.update({
      where: { id: project.id },
      data: { handbookSource: 'LIBRARY', libraryHandbookId: version.id },
    });
    return this.state(user, project.id);
  }

  /** Back to the project's own uploaded handbook (the university selection is cleared). */
  async useUploadedHandbook(
    user: AuthUser,
    projectId: string,
  ): Promise<ProjectHandbookStateDto> {
    const project = await this.access.assertLeaderOfProject(user, projectId);
    await this.prisma.project.update({
      where: { id: project.id },
      data: { handbookSource: 'UPLOAD', libraryHandbookId: null },
    });
    return this.state(user, project.id);
  }

  async versions(
    user: AuthUser,
    projectId: string,
  ): Promise<ProjectHandbookVersionDto[]> {
    const project = await this.access.assertCanViewProject(user, projectId);
    await this.failStale(project.id);
    const rows = await this.prisma.projectHandbook.findMany({
      where: { projectId: project.id },
      orderBy: { version: 'desc' },
      select: VERSION_SELECT,
      take: 50,
    });
    const users = await this.uploaders(rows);
    return rows.map((r) => this.toView(r, users));
  }

  async fileUrl(
    user: AuthUser,
    projectId: string,
    handbookId?: string,
  ): Promise<HandbookFileUrlDto> {
    const project = await this.access.assertCanViewProject(user, projectId);
    const row = await this.prisma.projectHandbook.findFirst({
      where: handbookId
        ? { id: handbookId, projectId: project.id }
        : { projectId: project.id, isActive: true },
      select: { storagePath: true, fileName: true },
    });
    if (!row) {
      throw new NotFoundException(
        err('HANDBOOK_NOT_FOUND', 'This project has no handbook yet'),
      );
    }
    return {
      url: await this.storage.createSignedUrl(row.storagePath),
      fileName: row.fileName,
    };
  }

  /**
   * Handbook used by the AI for a project = ONLY the handbook selected for it: the chosen
   * university handbook (LIBRARY) or the project's own active upload. There is no silent
   * fallback to another handbook. Returns the text for retrieval.
   */
  async findForAi(project: { id: string; teamId: string }): Promise<{
    source: 'PROJECT' | 'LIBRARY';
    id: string;
    title: string;
    extractedText: string;
  } | null> {
    const effective = await loadEffectiveHandbook(this.prisma, project.id);
    if (effective.source === 'LIBRARY') {
      if (!effective.libraryVersion) return null;
      const v = await this.prisma.universityHandbook.findUnique({
        where: { id: effective.libraryVersion.id },
        select: { extractedText: true },
      });
      if (v?.extractedText) {
        return {
          source: 'LIBRARY',
          id: effective.libraryVersion.id,
          title: effective.libraryVersion.title,
          extractedText: v.extractedText,
        };
      }
      return null;
    }
    const own = await this.prisma.projectHandbook.findFirst({
      where: {
        projectId: project.id,
        isActive: true,
        status: HandbookStatus.READY,
      },
      select: { id: true, title: true, extractedText: true },
    });
    if (own?.extractedText) {
      return {
        source: 'PROJECT',
        id: own.id,
        title: own.title,
        extractedText: own.extractedText,
      };
    }
    return null;
  }

  /** Resolves when background processing is finished (tests, shutdown). */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  async onApplicationShutdown() {
    await this.whenIdle();
  }

  // ==========================================================
  // Internals
  // ==========================================================

  private validateFile(file: UploadedDocumentFile | undefined) {
    if (!file) {
      throw new BadRequestException(
        err('FILE_REQUIRED', 'Attach the handbook PDF as "file"'),
      );
    }
    if (!file.size || file.buffer.length === 0) {
      throw new BadRequestException(err('FILE_EMPTY', 'The file is empty'));
    }
    const max = this.universityHandbooks.maxFileBytes;
    if (file.size > max || file.buffer.length > max) {
      throw new PayloadTooLargeException(
        err(
          'FILE_TOO_LARGE',
          `The handbook must be at most ${max / 1024 / 1024} MB`,
        ),
      );
    }
    if (file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new BadRequestException(
        err('HANDBOOK_NOT_PDF', 'The handbook must be a PDF file'),
      );
    }
    return file;
  }

  private track(work: Promise<void>) {
    const p = work.finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /** Background step: extract text, then READY (+ active) or FAILED. Never throws. */
  private async process(handbookId: string, buffer: Buffer): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    let errorCode: string | null = null;
    let extracted: Awaited<ReturnType<typeof extractPdfText>> | null = null;
    try {
      extracted = await extractPdfText(buffer);
      if (extracted.text.replace(/\s/g, '').length < MIN_HANDBOOK_TEXT_CHARS) {
        errorCode = 'HANDBOOK_NO_TEXT';
      }
    } catch (error) {
      this.logger.warn(
        `PDF extraction failed: ${(error as Error)?.name ?? 'Error'}`,
      );
      errorCode = 'HANDBOOK_UNREADABLE';
    }

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const current = await tx.projectHandbook.findUnique({
          where: { id: handbookId },
          select: { id: true, projectId: true, status: true, version: true },
        });
        // deleted project, or already marked as interrupted
        if (!current || current.status !== HandbookStatus.PROCESSING)
          return null;
        await this.lockProject(current.projectId, tx);
        if (errorCode || !extracted) {
          await tx.projectHandbook.update({
            where: { id: handbookId },
            data: {
              status: HandbookStatus.FAILED,
              errorCode: errorCode ?? 'HANDBOOK_PROCESSING_FAILED',
              processedAt: new Date(),
            },
          });
          return { ...current, ready: false };
        }
        // only a newer READY version can replace the active one
        const newerActive = await tx.projectHandbook.findFirst({
          where: {
            projectId: current.projectId,
            isActive: true,
            version: { gt: current.version },
          },
          select: { id: true },
        });
        if (!newerActive) {
          await tx.projectHandbook.updateMany({
            where: { projectId: current.projectId, isActive: true },
            data: { isActive: false },
          });
        }
        await tx.projectHandbook.update({
          where: { id: handbookId },
          data: {
            status: HandbookStatus.READY,
            isActive: !newerActive,
            pageCount: extracted.pageCount,
            extractedText: extracted.text,
            extractedChars: extracted.text.length,
            sectionCount: chunkHandbook(extracted.text).length,
            errorCode: null,
            processedAt: new Date(),
          },
        });
        return { ...current, ready: true };
      });
      if (row) await this.notifyProcessed(handbookId, row.projectId, row.ready);
    } catch (error) {
      this.logger.error(
        `could not finish handbook ${handbookId}: ${(error as Error)?.name ?? 'Error'}`,
      );
      await this.prisma.projectHandbook
        .updateMany({
          where: { id: handbookId, status: HandbookStatus.PROCESSING },
          data: {
            status: HandbookStatus.FAILED,
            errorCode: 'HANDBOOK_PROCESSING_FAILED',
            processedAt: new Date(),
          },
        })
        .catch(() => undefined);
    }
  }

  private async notifyProcessed(
    handbookId: string,
    projectId: string,
    ready: boolean,
  ) {
    try {
      const row = await this.prisma.projectHandbook.findUnique({
        where: { id: handbookId },
        select: {
          title: true,
          version: true,
          uploadedById: true,
          errorCode: true,
          project: { select: { teamId: true, name: true } },
        },
      });
      if (!row) return;
      const leaderId = await this.access.getTeamLeaderId(row.project.teamId);
      await this.notifications.notify(
        [row.uploadedById, leaderId].filter((x): x is string => !!x),
        {
          type: NotificationType.HANDBOOK_PROCESSED,
          title: ready ? 'Handbook ready' : 'Handbook could not be processed',
          message: ready
            ? `"${row.title}" (version ${row.version}) is ready. The AI assistant now uses it for ${row.project.name}.`
            : `"${row.title}" (version ${row.version}) failed: ${ERROR_MESSAGES[row.errorCode ?? ''] ?? 'please upload it again.'}`,
          data: {
            projectId,
            projectName: row.project.name,
            handbookTitle: row.title,
            handbookId,
            version: row.version,
            status: ready ? 'READY' : 'FAILED',
            ...(row.errorCode && { errorCode: row.errorCode }),
          },
          dedupeKey: `handbook-processed:${handbookId}`,
          email: true,
        },
      );
    } catch {
      this.logger.error(`could not notify about handbook ${handbookId}`);
    }
  }

  /** PROCESSING rows that outlived a restart become FAILED (state is never stuck). */
  private async failStale(projectId: string) {
    await this.prisma.projectHandbook.updateMany({
      where: {
        projectId,
        status: HandbookStatus.PROCESSING,
        processingStartedAt: {
          lt: new Date(Date.now() - HANDBOOK_PROCESSING_STALE_MS),
        },
      },
      data: {
        status: HandbookStatus.FAILED,
        errorCode: 'HANDBOOK_PROCESSING_INTERRUPTED',
        processedAt: new Date(),
      },
    });
  }

  private async uploaders(rows: ({ uploadedById: string | null } | null)[]) {
    const ids = [
      ...new Set(
        rows.map((r) => r?.uploadedById).filter((x): x is string => !!x),
      ),
    ];
    if (ids.length === 0) return new Map<string, Uploader>();
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, firstName: true, lastName: true },
    });
    return new Map<string, Uploader>(
      users.map((u) => [
        u.id,
        { id: u.id, firstName: u.firstName ?? '', lastName: u.lastName ?? '' },
      ]),
    );
  }

  private toView(
    row: VersionRow,
    users: Map<string, Uploader>,
  ): ProjectHandbookVersionDto {
    return {
      id: row.id,
      version: row.version,
      status: row.status,
      isActive: row.isActive,
      title: row.title,
      fileName: row.fileName,
      fileSize: row.fileSize,
      pageCount: row.pageCount,
      extractedChars: row.extractedChars,
      sectionCount: row.sectionCount,
      errorCode: row.errorCode,
      errorMessage: row.errorCode
        ? (ERROR_MESSAGES[row.errorCode] ?? null)
        : null,
      uploadedBy: row.uploadedById
        ? (users.get(row.uploadedById) ?? null)
        : null,
      createdAt: row.createdAt,
      processedAt: row.processedAt,
    };
  }

  /** Row lock on the project: serialises version numbers and activation. */
  private async lockProject(projectId: string, db: Db) {
    await db.project.update({
      where: { id: projectId },
      data: { updatedAt: new Date() },
    });
  }
}

/** Project handbook PDFs live under handbooks/projects/<projectId>/ only. */
export function isProjectHandbookPath(path: string, projectId: string): boolean {
  const prefix = `${HANDBOOK_FOLDER}/projects/${projectId}/`;
  return (
    path.startsWith(prefix) &&
    path.length > prefix.length &&
    !path.slice(prefix.length).includes('/') &&
    !path.includes('..')
  );
}
