import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  DocumentCategory,
  NotificationType,
  Prisma,
  StoredObjectKind,
  SubmissionStatus,
} from '@prisma/client';
import { StorageQuotaService } from '@modules/storage/storage-quota.service';
import {
  StorageCleanupResult,
  StorageDeletionService,
} from '@modules/storage/storage-deletion.service';
import { NotificationsService } from '@modules/notifications/notifications.service';

import { PrismaService } from '@/prisma/prisma.service';
import { AuthUser } from '@common/types/auth-user.type';
import { WorkspaceAccessService } from '@common/workspace/workspace-access.service';
import {
  WorkspaceErrorCode as E,
  workspaceError,
} from '@common/workspace/workspace-errors';
import { PUBLIC_USER_SELECT } from '@common/workspace/user-select';

import { UpdateDocumentDto } from './dto/update-document.dto';
import { UploadDocumentDto } from './dto/upload-document.dto';
import { DocumentQueryDto } from './dto/document-query.dto';
import {
  DocumentDetailsDto,
  DocumentVersionViewDto,
  DocumentViewDto,
} from './dto/document-response.dto';
import {
  assertAllowedFile,
  buildStoragePath,
  documentFolderOf,
  fileNameFromStoragePath,
  isInProjectScope,
  SIGNED_URL_TTL_SECONDS,
  storageContentType,
  UploadedDocumentFile,
  withDownloadName,
} from './document-files';
import { SupabaseStorageService } from './supabase-storage.service';

export type { UploadedDocumentFile } from './document-files';

const DOCUMENT_SELECT = {
  id: true,
  title: true,
  description: true,
  projectId: true,
  category: true,
  fileUrl: true,
  fileType: true,
  fileSize: true,
  isPublic: true,
  reviewStatus: true,
  reviewStatusUpdatedAt: true,
  createdAt: true,
  updatedAt: true,
  uploadedBy: { select: PUBLIC_USER_SELECT },
  versions: {
    select: { version: true },
    orderBy: { version: 'desc' },
    take: 1,
  },
  _count: { select: { versions: true } },
} satisfies Prisma.DocumentSelect;

type DocumentRow = Prisma.DocumentGetPayload<{
  select: typeof DOCUMENT_SELECT;
}>;

/**
 * Project documents stored in the PRIVATE Supabase bucket "project-documents".
 *
 * - Students of the project team: upload, new version, update metadata, delete.
 * - Supervisors of the project: read only (list, details, versions).
 * - Everyone else (incl. ADMIN): denied by WorkspaceAccessService.
 *
 * Consistency rules
 * - Upload: file first, then DB in one transaction; if the DB step fails the
 *   just-uploaded object is removed. Nothing is ever deleted after a commit.
 * - New version: the document row is locked (UPDATE) before reading the latest
 *   version, so concurrent uploads get distinct, consecutive numbers.
 * - Delete: DB rows first (transaction), then all of the document's objects in
 *   one Storage request; objects outside the project's folder are never deleted.
 */
@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly storage: SupabaseStorageService,
    private readonly notifications: NotificationsService,
    private readonly quota: StorageQuotaService,
    private readonly deletions: StorageDeletionService,
  ) {}

  // ==========================================================
  // Writes (students of the project team; TeamRole is not checked)
  // ==========================================================

  async upload(
    user: AuthUser,
    dto: UploadDocumentDto,
    file: UploadedDocumentFile | undefined,
  ): Promise<DocumentViewDto> {
    const fileName = assertAllowedFile(file);
    const project = await this.access.assertStudentOfProject(
      user,
      dto.projectId,
    );
    const upload = file!;
    // storage quota (uploader's account, all projects): refused BEFORE anything is stored
    await this.quota.assertCanStore(user, upload.size);

    const storagePath = buildStoragePath(project.id, randomUUID(), fileName);
    await this.storage.upload(
      storagePath,
      upload.buffer,
      storageContentType(upload.mimetype, upload.buffer),
    );

    let documentId: string;
    try {
      documentId = await this.prisma.$transaction(async (tx) => {
        // atomic re-check (parallel uploads of the same student)
        await this.quota.reserveInTransaction(user, upload.size, tx);
        const created = await tx.document.create({
          data: {
            title: dto.title,
            description: dto.description || null,
            projectId: project.id,
            uploadedById: user.id,
            fileUrl: storagePath,
            fileType: displayMimeType(upload.mimetype),
            fileSize: upload.size,
            category: dto.category ?? DocumentCategory.GENERAL,
            isPublic: false,
            // regular project files are available at once; review only when asked for
            reviewStatus: dto.submitForReview
              ? SubmissionStatus.SUBMITTED
              : SubmissionStatus.UPLOADED,
          },
          select: { id: true },
        });
        await tx.documentVersion.create({
          data: {
            documentId: created.id,
            fileUrl: storagePath,
            version: 1,
            fileSize: upload.size,
            uploadedById: user.id,
          },
        });
        if (dto.submitForReview) {
          await this.notifySupervisors(
            tx,
            project.id,
            created.id,
            dto.title,
            1,
          );
        }
        return created.id;
      });
    } catch (error) {
      await this.removeAfterFailedWrite(
        user,
        project.id,
        storagePath,
        upload.size,
      );
      throw error;
    }

    return this.toView(await this.loadOrThrow(documentId));
  }

  async createVersion(
    user: AuthUser,
    documentId: string,
    file: UploadedDocumentFile | undefined,
    options: { submitForReview?: boolean } = {},
  ): Promise<DocumentViewDto> {
    const fileName = assertAllowedFile(file);
    const current = await this.loadOrThrow(documentId);
    await this.assertCanManage(user, current.projectId, current.uploadedBy.id);
    const upload = file!;
    // a new version is a new stored object, charged to whoever uploads it
    await this.quota.assertCanStore(user, upload.size);

    // All versions of a document share its folder.
    const folder = documentFolderOf(current.fileUrl) ?? randomUUID();
    const storagePath = buildStoragePath(current.projectId, folder, fileName);
    await this.storage.upload(
      storagePath,
      upload.buffer,
      storageContentType(upload.mimetype, upload.buffer),
    );

    // a regular file stays a regular file; a file already in the review workflow (or one
    // explicitly sent for review) is (re)submitted: the previous decision was for the old file
    const resubmit =
      !!options.submitForReview ||
      current.reviewStatus !== SubmissionStatus.UPLOADED;
    try {
      await this.prisma.$transaction(async (tx) => {
        // 0) uploader's quota (advisory lock, then re-check)
        await this.quota.reserveInTransaction(user, upload.size, tx);
        // 1) UPDATE first: row lock on the document -> concurrent version uploads
        //    for the same document wait here and then see the committed number.
        await tx.document.update({
          where: { id: documentId },
          data: {
            fileUrl: storagePath,
            fileType: displayMimeType(upload.mimetype),
            fileSize: upload.size,
            reviewStatus: resubmit
              ? SubmissionStatus.SUBMITTED
              : SubmissionStatus.UPLOADED,
            reviewStatusUpdatedAt: new Date(),
          },
          select: { id: true, title: true },
        });
        // 2) next number under the lock (unique [documentId, version] stays the backstop)
        const latest = await tx.documentVersion.findFirst({
          where: { documentId },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        const version = (latest?.version ?? 0) + 1;
        await tx.documentVersion.create({
          data: {
            documentId,
            fileUrl: storagePath,
            version,
            fileSize: upload.size,
            uploadedById: user.id,
          },
        });
        if (resubmit) {
          await this.notifySupervisors(
            tx,
            current.projectId,
            documentId,
            current.title,
            version,
          );
        }
      });
    } catch (error) {
      await this.removeAfterFailedWrite(
        user,
        current.projectId,
        storagePath,
        upload.size,
      );
      if (isRecordNotFound(error)) throw documentNotFound(); // deleted meanwhile
      throw error;
    }

    return this.toView(await this.loadOrThrow(documentId));
  }

  /** A regular file (UPLOADED) is sent to the supervisor: SUBMITTED + notification. */
  async submitForReview(
    user: AuthUser,
    documentId: string,
  ): Promise<DocumentViewDto> {
    const current = await this.loadOrThrow(documentId);
    await this.assertCanManage(user, current.projectId, current.uploadedBy.id);
    if (current.reviewStatus === SubmissionStatus.UPLOADED) {
      await this.prisma.$transaction(async (tx) => {
        const changed = await tx.document.updateMany({
          where: { id: documentId, reviewStatus: SubmissionStatus.UPLOADED },
          data: {
            reviewStatus: SubmissionStatus.SUBMITTED,
            reviewStatusUpdatedAt: new Date(),
          },
        });
        if (changed.count === 0) return; // sent meanwhile
        await this.notifySupervisors(
          tx,
          current.projectId,
          documentId,
          current.title,
          current.versions[0]?.version ?? 1,
        );
      });
    }
    return this.toView(await this.loadOrThrow(documentId));
  }

  async update(
    user: AuthUser,
    documentId: string,
    dto: UpdateDocumentDto,
  ): Promise<DocumentViewDto> {
    const current = await this.loadOrThrow(documentId);
    await this.assertCanManage(user, current.projectId, current.uploadedBy.id);

    const row = await this.prisma.document.update({
      where: { id: documentId },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.description !== undefined && {
          description: dto.description || null,
        }),
        ...(dto.category !== undefined && { category: dto.category }),
      },
      select: DOCUMENT_SELECT,
    });
    return this.toView(row);
  }

  /**
   * Deletes the document, all its versions and their stored files.
   *
   * Storage space is released only when Supabase confirms the removal: the stored
   * objects are moved to storage_pending_deletions in the same transaction that deletes
   * the rows (they keep counting toward each uploader's quota), then removed from
   * Storage. If Storage fails, the document is still deleted for the users, the response
   * says `storage.status = PENDING_DELETION`, and the removal is retried in the background.
   */
  async remove(
    user: AuthUser,
    documentId: string,
  ): Promise<{ message: string; storage: StorageCleanupResult }> {
    const current = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, projectId: true, uploadedById: true },
    });
    if (!current) throw documentNotFound();
    await this.assertCanManage(user, current.projectId, current.uploadedById);

    // 1) database: lock the document (a parallel new version waits), read every stored
    //    object, record them as pending deletions, then delete versions + document
    let paths: string[];
    try {
      paths = await this.prisma.$transaction(async (tx) => {
        await tx.document.update({
          where: { id: documentId },
          data: { updatedAt: new Date() },
          select: { id: true },
        });
        const doc = await tx.document.findUnique({
          where: { id: documentId },
          select: {
            fileUrl: true,
            uploadedById: true,
            versions: {
              select: { fileUrl: true, fileSize: true, uploadedById: true },
            },
          },
        });
        const objects = [
          ...doc!.versions.map((v) => ({
            storagePath: v.fileUrl,
            fileSize: v.fileSize,
            uploadedById: v.uploadedById,
          })),
          // the current file is normally also a version (then deduplicated)
          {
            storagePath: doc!.fileUrl,
            fileSize: null,
            uploadedById: doc!.uploadedById,
          },
        ].map((o) => ({
          ...o,
          kind: StoredObjectKind.DOCUMENT_FILE,
          projectId: current.projectId,
          safeToDelete: isInProjectScope(o.storagePath, current.projectId),
        }));
        await this.deletions.queue(tx, objects);
        await tx.documentVersion.deleteMany({ where: { documentId } });
        await tx.document.delete({ where: { id: documentId } });
        return [...new Set(objects.map((o) => o.storagePath))];
      });
    } catch (error) {
      if (isRecordNotFound(error)) throw documentNotFound(); // deleted meanwhile
      throw error;
    }

    // 2) storage: only a confirmed removal releases the space
    const storage = await this.deletions.removeNow(paths);
    if (storage.status !== 'REMOVED') {
      this.logger.error(
        `Document ${documentId} deleted; ${storage.pendingObjects} stored object(s) not removed yet (still counted, retried later)`,
      );
    }
    return {
      message:
        storage.status === 'REMOVED'
          ? 'Document deleted'
          : 'Document deleted. Its stored files could not be removed yet; they still count toward storage until the removal succeeds (retried automatically).',
      storage,
    };
  }

  // ==========================================================
  // Reads (students of the project, or its supervisor)
  // ==========================================================

  async findMany(
    user: AuthUser,
    query: DocumentQueryDto = {},
  ): Promise<DocumentViewDto[]> {
    const { projectId, status } = query;
    let projectIds: string[];
    if (projectId) {
      await this.access.assertCanViewProject(user, projectId);
      projectIds = [projectId];
    } else {
      projectIds = await this.access.getReadableProjectIds(user);
    }
    if (projectIds.length === 0) return [];

    const rows = await this.prisma.document.findMany({
      where: {
        projectId: { in: projectIds },
        ...(status && { reviewStatus: status }),
      },
      select: DOCUMENT_SELECT,
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    });
    return rows.map((row) => this.toView(row));
  }

  async findOne(
    user: AuthUser,
    documentId: string,
  ): Promise<DocumentDetailsDto> {
    const row = await this.loadOrThrow(documentId);
    await this.access.assertCanViewProject(user, row.projectId);

    const view = this.toView(row);
    const signedUrl = await this.storage.createSignedUrl(row.fileUrl);
    return {
      ...view,
      signedUrl,
      downloadUrl: withDownloadName(signedUrl, view.fileName),
      signedUrlExpiresAt: expiresAt(),
    };
  }

  async getVersions(
    user: AuthUser,
    documentId: string,
  ): Promise<DocumentVersionViewDto[]> {
    const current = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { projectId: true },
    });
    if (!current) throw documentNotFound();
    await this.access.assertCanViewProject(user, current.projectId);

    const versions = await this.prisma.documentVersion.findMany({
      where: { documentId },
      orderBy: { version: 'desc' },
    });
    // one Storage request for all versions
    const urls = await this.storage.createSignedUrls(
      versions.map((v) => v.fileUrl),
    );
    const until = expiresAt();
    return versions.map((v, i) => {
      const fileName = fileNameFromStoragePath(v.fileUrl);
      return {
        id: v.id,
        documentId: v.documentId,
        version: v.version,
        fileUrl: v.fileUrl,
        fileName,
        createdAt: v.createdAt,
        signedUrl: urls[i],
        downloadUrl: withDownloadName(urls[i], fileName),
        signedUrlExpiresAt: until,
      };
    });
  }

  // ==========================================================
  // Internals
  // ==========================================================

  /**
   * P16: a file can be replaced (new version), renamed or deleted by the student who
   * uploaded it or by the team LEADER — not by other members.
   */
  private async assertCanManage(
    user: AuthUser,
    projectId: string,
    uploadedById: string,
  ) {
    const project = await this.access.assertStudentOfProject(user, projectId);
    if (uploadedById === user.id) return;
    if (await this.access.isLeaderOfTeam(user.id, project.teamId)) return;
    throw new ForbiddenException(
      workspaceError(
        E.DOCUMENT_NOT_OWNER,
        'Only the student who uploaded this file or the team leader can change or delete it',
      ),
    );
  }

  private async loadOrThrow(documentId: string): Promise<DocumentRow> {
    const row = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: DOCUMENT_SELECT,
    });
    if (!row) throw documentNotFound();
    return row;
  }

  private toView(row: DocumentRow): DocumentViewDto {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      projectId: row.projectId,
      category: row.category,
      fileUrl: row.fileUrl,
      fileName: fileNameFromStoragePath(row.fileUrl),
      fileType: row.fileType,
      fileSize: row.fileSize,
      isPublic: row.isPublic,
      reviewStatus: row.reviewStatus,
      reviewStatusUpdatedAt: row.reviewStatusUpdatedAt,
      currentVersion: row.versions[0]?.version ?? 1,
      versionCount: row._count.versions,
      uploadedBy: row.uploadedBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** P08: tells the project's supervisor(s) about a new submission (same transaction). */
  private async notifySupervisors(
    tx: Prisma.TransactionClient,
    projectId: string,
    documentId: string,
    title: string,
    version: number,
  ) {
    await this.notifications.notify(
      await this.access.getProjectSupervisorIds(projectId, tx),
      {
        type: NotificationType.DOCUMENT_SUBMITTED,
        title: version === 1 ? 'New submission' : 'Document resubmitted',
        message:
          version === 1
            ? `A new document "${title}" was submitted for review.`
            : `"${title}" was resubmitted (version ${version}).`,
        data: {
          kind: 'document_submitted',
          documentTitle: title,
          projectId,
          documentId,
          version,
        },
        // one notification (and e-mail) per uploaded version
        dedupeKey: `document:${documentId}:v${version}`,
        email: true,
      },
      tx,
    );
  }

  /**
   * Removes an object uploaded by a write whose DB step failed. Never hides the DB error;
   * if Storage fails too, the object is recorded as pending (still charged to the uploader).
   */
  private async removeAfterFailedWrite(
    user: AuthUser,
    projectId: string,
    storagePath: string,
    size: number,
  ) {
    await this.deletions.removeAfterFailedWrite({
      storagePath,
      kind: StoredObjectKind.DOCUMENT_FILE,
      fileSize: size,
      uploadedById: user.id,
      projectId,
      safeToDelete: isInProjectScope(storagePath, projectId),
    });
  }
}

function documentNotFound() {
  return new NotFoundException(
    workspaceError(E.DOCUMENT_NOT_FOUND, 'Document not found'),
  );
}

function isRecordNotFound(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2025'
  );
}

function displayMimeType(mimetype: string): string {
  const type = (mimetype || '').split(';')[0].trim().toLowerCase();
  return type || 'application/octet-stream';
}

function expiresAt(): Date {
  return new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000);
}
