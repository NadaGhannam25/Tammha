import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, StoredObjectKind, UserRole } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import {
  readStorageQuotaSettings,
  STORAGE_CRITICAL_AT,
  STORAGE_WARNING_AT,
} from './storage-quota.config';
import { StorageStatus, StorageUsageDto } from './dto/storage-usage.dto';

type Db = PrismaService | Prisma.TransactionClient;
type Uploader = { id: string; role: UserRole | string };

export const STORAGE_QUOTA_EXCEEDED = 'STORAGE_QUOTA_EXCEEDED';

export interface StorageTotals {
  documentBytes: number;
  handbookBytes: number;
  files: number;
  filesWithUnknownSize: number;
}

/**
 * Student storage quota — ONE quota per STUDENT account, shared by all their projects
 * (never per project). It is a limit, not reserved space.
 *
 * Usage is CALCULATED from file metadata, never from a hand-maintained counter, so it
 * cannot drift: the sum of the sizes of every stored object the student uploaded —
 *   - document_versions.fileSize where uploadedById = student (version 1 is the original
 *     upload; every later version is its own stored object), and
 *   - project_handbooks.fileSize where uploadedById = student (every stored version,
 *     including failed ones, until it is deleted).
 *   - storage_pending_deletions.fileSize where uploadedById = student: objects whose record
 *     was deleted but whose removal from Supabase Storage is not confirmed yet.
 * Objects are charged to the account that uploaded them: a leader or supervisor uploading
 * never consumes another student's quota. Deleting a document or a handbook version moves
 * its objects to pending deletions (still counted); the usage drops only once Supabase
 * Storage confirmed the removal (StorageDeletionService).
 *
 * Every upload path calls assertCanStore() BEFORE the object is stored (nothing is
 * stored when the quota would be exceeded) and reserveInTransaction() in the database
 * transaction that records it: a per-student PostgreSQL advisory lock makes the
 * check-and-insert atomic, so parallel uploads cannot pass the limit together (the
 * caller removes the just-stored object if the second check fails).
 *
 * SUPERVISOR and ADMIN accounts have no student quota.
 */
@Injectable()
export class StorageQuotaService {
  readonly studentQuotaBytes: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.studentQuotaBytes = readStorageQuotaSettings({
      STUDENT_STORAGE_QUOTA_GB: config.get<string>('STUDENT_STORAGE_QUOTA_GB'),
    }).studentQuotaBytes;
  }

  /** null = no quota for this account type */
  quotaFor(user: { role: UserRole | string }): number | null {
    return user.role === UserRole.STUDENT ? this.studentQuotaBytes : null;
  }

  /**
   * Sums the recorded sizes in JavaScript (exact up to 2^53 bytes): the columns are
   * INTEGER, and a database SUM over a student's files can exceed the 32-bit range long
   * before the 10 GB quota is reached. Only the size column is read (indexed lookup).
   */
  async totals(userId: string, db: Db = this.prisma): Promise<StorageTotals> {
    const [versions, handbooks, pending] = await Promise.all([
      db.documentVersion.findMany({
        where: { uploadedById: userId },
        select: { fileSize: true },
      }),
      db.projectHandbook.findMany({
        where: { uploadedById: userId },
        select: { fileSize: true },
      }),
      // deleted records whose stored object is not confirmed removed: still occupy space
      db.storagePendingDeletion.findMany({
        where: { uploadedById: userId },
        select: { fileSize: true, kind: true },
      }),
    ]);
    const sum = (rows: { fileSize: number | null }[]) =>
      rows.reduce((total, r) => total + (r.fileSize ?? 0), 0);
    const pendingHandbooks = pending.filter(
      (p) => p.kind === StoredObjectKind.PROJECT_HANDBOOK,
    );
    const pendingDocuments = pending.filter(
      (p) => p.kind !== StoredObjectKind.PROJECT_HANDBOOK,
    );
    return {
      documentBytes: sum(versions) + sum(pendingDocuments),
      handbookBytes: sum(handbooks) + sum(pendingHandbooks),
      files: versions.length + handbooks.length + pending.length,
      filesWithUnknownSize: [...versions, ...pending].filter(
        (v) => v.fileSize === null,
      ).length,
    };
  }

  async usedBytes(userId: string, db: Db = this.prisma): Promise<number> {
    const t = await this.totals(userId, db);
    return t.documentBytes + t.handbookBytes;
  }

  /** GET /users/me/storage */
  async summary(user: Uploader): Promise<StorageUsageDto> {
    const totals = await this.totals(user.id);
    const used = totals.documentBytes + totals.handbookBytes;
    const quota = this.quotaFor(user);
    return {
      quotaApplies: quota !== null,
      usedBytes: used,
      quotaBytes: quota,
      remainingBytes: quota === null ? null : Math.max(0, quota - used),
      percentageUsed:
        quota === null
          ? null
          : Math.min(100, Math.round((used / quota) * 1000) / 10),
      status: storageStatus(used, quota),
      thresholds: {
        warningAt: STORAGE_WARNING_AT,
        criticalAt: STORAGE_CRITICAL_AT,
      },
      breakdown: totals,
      projects: await this.byProject(user.id),
    };
  }

  /**
   * Before storing: 409 STORAGE_QUOTA_EXCEEDED when used + bytes > quota.
   * Viewing, downloading and deleting are never checked.
   */
  async assertCanStore(user: Uploader, bytes: number, db: Db = this.prisma) {
    const quota = this.quotaFor(user);
    if (quota === null) return;
    const used = await this.usedBytes(user.id, db);
    if (used + bytes > quota) throw quotaExceeded(used, quota, bytes);
  }

  /**
   * Inside the transaction that records the new object: serialises this student's
   * uploads (advisory lock until commit/rollback) and checks again.
   */
  async reserveInTransaction(
    user: Uploader,
    bytes: number,
    tx: Prisma.TransactionClient,
  ) {
    if (this.quotaFor(user) === null) return;
    const key = `storage-quota:${user.id}`;
    await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${key}))) AS l`;
    await this.assertCanStore(user, bytes, tx);
  }

  private async byProject(userId: string) {
    const [versions, handbooks, pending] = await Promise.all([
      this.prisma.documentVersion.findMany({
        where: { uploadedById: userId },
        select: { fileSize: true, document: { select: { projectId: true } } },
      }),
      this.prisma.projectHandbook.findMany({
        where: { uploadedById: userId },
        select: { fileSize: true, projectId: true },
      }),
      this.prisma.storagePendingDeletion.findMany({
        where: { uploadedById: userId, projectId: { not: null } },
        select: { fileSize: true, projectId: true },
      }),
    ]);
    const sums = new Map<string, number>();
    const add = (projectId: string, size: number | null) =>
      sums.set(projectId, (sums.get(projectId) ?? 0) + (size ?? 0));
    for (const v of versions) add(v.document.projectId, v.fileSize);
    for (const h of handbooks) add(h.projectId, h.fileSize);
    for (const p of pending) add(p.projectId!, p.fileSize);
    if (sums.size === 0) return [];
    const names = await this.prisma.project.findMany({
      where: { id: { in: [...sums.keys()] } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(names.map((p) => [p.id, p.name]));
    return [...sums.entries()]
      .map(([projectId, usedBytes]) => ({
        projectId,
        projectName: nameOf.get(projectId) ?? null,
        usedBytes,
      }))
      .sort(
        (a, b) =>
          b.usedBytes - a.usedBytes || a.projectId.localeCompare(b.projectId),
      );
  }
}

export function storageStatus(
  used: number,
  quota: number | null,
): StorageStatus {
  if (quota === null) return 'NOT_LIMITED';
  if (used >= quota) return 'FULL';
  if (used >= quota * STORAGE_CRITICAL_AT) return 'CRITICAL';
  if (used >= quota * STORAGE_WARNING_AT) return 'WARNING';
  return 'NORMAL';
}

function quotaExceeded(used: number, quota: number, requested: number) {
  return new ConflictException({
    code: STORAGE_QUOTA_EXCEEDED,
    message:
      'Not enough storage left in your account. Delete files you no longer need, then try again.',
    details: {
      usedBytes: used,
      quotaBytes: quota,
      remainingBytes: Math.max(0, quota - used),
      requestedBytes: requested,
    },
  });
}
