import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  StorageDeletionStatus,
  StoredObjectKind,
} from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { SupabaseStorageService } from '@modules/documents/supabase-storage.service';
import { readNotificationSettings } from '@modules/notifications/notifications.config';
import {
  readStorageCleanupSettings,
  storageRetryDelayMs,
} from './storage-cleanup.config';

type Db = PrismaService | Prisma.TransactionClient;

/** A stored object whose database record is being deleted. */
export interface StoredObjectToDelete {
  storagePath: string;
  kind: StoredObjectKind;
  /** bytes charged to the uploader (null = unknown, counted as 0) */
  fileSize: number | null;
  uploadedById: string | null;
  projectId: string | null;
  /** false = path outside the expected folder: never deleted automatically (BLOCKED) */
  safeToDelete: boolean;
}

export type StorageCleanupStatus = 'REMOVED' | 'PENDING_DELETION';

export interface StorageCleanupResult {
  status: StorageCleanupStatus;
  /** objects still waiting for removal (they keep counting toward the quota) */
  pendingObjects: number;
}

/** Re-claim lease: a row being retried is not picked again by another run for this long. */
const CLAIM_LEASE_MS = 10 * 60_000;

/**
 * Safe deletion of stored objects (documents, document versions, project handbooks).
 *
 * Storage space is never reported as free before the object is really gone:
 * 1. In the SAME transaction that deletes the database record, every stored object of
 *    that record is written to storage_pending_deletions (path, size, uploader). The
 *    quota keeps counting these rows, so the usage does not drop yet.
 * 2. After the commit the objects are removed from Supabase Storage. Only when Storage
 *    confirms the removal are the pending rows deleted, and the usage drops.
 * 3. If Storage fails, the rows stay (attempts, lastError, nextAttemptAt), the failure is
 *    logged, the caller gets status PENDING_DELETION, and a background job retries with
 *    backoff (STORAGE_CLEANUP_INTERVAL_SECONDS) until it succeeds.
 *
 * Removing an object that is already gone counts as success (Supabase reports no error),
 * so retries are idempotent. Objects outside their expected folder are recorded as
 * BLOCKED: never deleted automatically and still counted, so they are never hidden.
 */
@Injectable()
export class StorageDeletionService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger('StorageDeletion');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: SupabaseStorageService,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap() {
    const { settings } = readNotificationSettings({
      REMINDERS_ENABLED: this.config.get<string>('REMINDERS_ENABLED'),
    });
    if (!settings.remindersEnabled) return; // tests / read-only runs: no background jobs
    const { intervalSeconds } = readStorageCleanupSettings({
      STORAGE_CLEANUP_INTERVAL_SECONDS: this.config.get<string>(
        'STORAGE_CLEANUP_INTERVAL_SECONDS',
      ),
    });
    this.timer = setInterval(() => void this.runOnce(), intervalSeconds * 1000);
    this.timer.unref?.();
    this.logger.log(
      `failed storage deletions retried every ${intervalSeconds} s`,
    );
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One background run; skipped while the previous one is still going. */
  async runOnce() {
    if (this.running) return;
    this.running = true;
    try {
      await this.retryDue();
    } catch (error) {
      this.logger.warn(`storage cleanup run failed: ${errorCode(error)}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Step 1 — call INSIDE the transaction that deletes the database record(s), so the
   * size moves from the record to a pending row atomically (usage stays the same).
   */
  async queue(db: Db, objects: StoredObjectToDelete[]): Promise<void> {
    const seen = new Set<string>();
    for (const o of objects) {
      if (!o.storagePath || seen.has(o.storagePath)) continue;
      seen.add(o.storagePath);
      const blocked = !o.safeToDelete;
      await db.storagePendingDeletion.upsert({
        where: { storagePath: o.storagePath },
        // already recorded: a later deletion by the object's real owner (inside its own
        // folder) takes over a BLOCKED row; otherwise the existing row is kept as it is
        update: blocked
          ? {}
          : {
              status: StorageDeletionStatus.PENDING,
              kind: o.kind,
              fileSize: o.fileSize,
              uploadedById: o.uploadedById,
              projectId: o.projectId,
              lastError: null,
              nextAttemptAt: new Date(),
            },
        create: {
          storagePath: o.storagePath,
          kind: o.kind,
          status: blocked
            ? StorageDeletionStatus.BLOCKED
            : StorageDeletionStatus.PENDING,
          fileSize: o.fileSize,
          uploadedById: o.uploadedById,
          projectId: o.projectId,
          lastError: blocked ? 'OUTSIDE_EXPECTED_FOLDER' : null,
          nextAttemptAt: new Date(),
        },
      });
      if (blocked) {
        this.logger.error(
          `stored object outside its expected folder was NOT deleted and still counts toward storage: ${o.storagePath}`,
        );
      }
    }
  }

  /**
   * Step 2 — after the commit: remove the queued objects now. Rows are deleted only
   * after Storage confirmed the removal; otherwise they stay for the retry job.
   */
  async removeNow(storagePaths: string[]): Promise<StorageCleanupResult> {
    const rows = await this.prisma.storagePendingDeletion.findMany({
      where: { storagePath: { in: [...new Set(storagePaths)] } },
      select: { id: true, storagePath: true, attempts: true, status: true },
    });
    const pending = rows.filter(
      (r) => r.status === StorageDeletionStatus.PENDING,
    );
    const blocked = rows.length - pending.length;
    const failed = await this.attempt(pending);
    const left = blocked + failed;
    return {
      status: left === 0 ? 'REMOVED' : 'PENDING_DELETION',
      pendingObjects: left,
    };
  }

  /**
   * An upload stored its object but the database write failed: remove it. If Storage
   * fails too, the object is recorded as pending (charged to the uploader) instead of
   * being forgotten, and retried later.
   */
  async removeAfterFailedWrite(object: StoredObjectToDelete): Promise<void> {
    try {
      await this.removeWithRetry([object.storagePath]);
      return;
    } catch (error) {
      this.logger.error(
        `could not remove stored object after a failed write (${errorCode(error)}); recorded for retry: ${object.storagePath}`,
      );
    }
    try {
      await this.queue(this.prisma, [object]);
      await this.prisma.storagePendingDeletion.updateMany({
        where: { storagePath: object.storagePath },
        data: {
          attempts: 1,
          lastError: 'STORAGE_DELETE_FAILED',
          lastAttemptAt: new Date(),
          nextAttemptAt: new Date(Date.now() + storageRetryDelayMs(1)),
        },
      });
    } catch (error) {
      this.logger.error(
        `could not record orphaned storage object ${object.storagePath} (${errorCode(error)})`,
      );
    }
  }

  /** Retry job: due PENDING rows, oldest first. Each row is claimed before it is tried. */
  async retryDue(now = new Date(), limit = 100) {
    const due = await this.prisma.storagePendingDeletion.findMany({
      where: {
        status: StorageDeletionStatus.PENDING,
        nextAttemptAt: { lte: now },
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: limit,
      select: {
        id: true,
        storagePath: true,
        attempts: true,
        nextAttemptAt: true,
      },
    });
    const claimed: typeof due = [];
    for (const row of due) {
      const { count } = await this.prisma.storagePendingDeletion.updateMany({
        where: { id: row.id, nextAttemptAt: row.nextAttemptAt },
        data: { nextAttemptAt: new Date(now.getTime() + CLAIM_LEASE_MS) },
      });
      if (count === 1) claimed.push(row);
    }
    const failed = await this.attempt(claimed);
    return {
      attempted: claimed.length,
      removed: claimed.length - failed,
      failed,
    };
  }

  /** Tries one Storage request (+1 immediate retry). Returns the number still pending. */
  private async attempt(
    rows: { id: string; storagePath: string; attempts: number }[],
  ): Promise<number> {
    if (rows.length === 0) return 0;
    try {
      await this.removeWithRetry(rows.map((r) => r.storagePath));
    } catch (error) {
      const code = errorCode(error);
      const at = new Date();
      for (const r of rows) {
        const attempts = r.attempts + 1;
        await this.prisma.storagePendingDeletion.update({
          where: { id: r.id },
          data: {
            attempts,
            lastError: code,
            lastAttemptAt: at,
            nextAttemptAt: new Date(
              at.getTime() + storageRetryDelayMs(attempts),
            ),
          },
        });
      }
      this.logger.error(
        `Storage deletion failed (${code}) for ${rows.length} object(s); they still count toward storage and will be retried: ${rows
          .map((r) => r.storagePath)
          .join(', ')}`,
      );
      return rows.length;
    }
    // confirmed removed: now the space is really free
    await this.prisma.storagePendingDeletion.deleteMany({
      where: { id: { in: rows.map((r) => r.id) } },
    });
    return 0;
  }

  private async removeWithRetry(paths: string[]) {
    if (paths.length === 0) return;
    try {
      await this.storage.remove(paths);
    } catch {
      await this.storage.remove(paths);
    }
  }
}

/** Short, safe error code for logs and the lastError column (never secrets). */
function errorCode(error: unknown): string {
  const e = error as {
    code?: unknown;
    response?: { code?: unknown };
    name?: unknown;
  };
  const code =
    e?.response?.code ?? e?.code ?? e?.name ?? 'STORAGE_DELETE_FAILED';
  return String(code).slice(0, 80);
}
