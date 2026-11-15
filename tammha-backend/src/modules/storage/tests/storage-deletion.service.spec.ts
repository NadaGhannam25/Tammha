import { StorageDeletionService } from '../storage-deletion.service';
import {
  DEFAULT_STORAGE_CLEANUP_INTERVAL_SECONDS,
  readStorageCleanupSettings,
  storageRetryDelayMs,
} from '../storage-cleanup.config';
import { createInMemoryPrisma } from '@/testing/in-memory-prisma';
import { FakeStorageService } from '@/testing/fake-storage';

describe('readStorageCleanupSettings', () => {
  it('defaults to 300 s and accepts 30-86400', () => {
    expect(readStorageCleanupSettings({})).toEqual({
      intervalSeconds: DEFAULT_STORAGE_CLEANUP_INTERVAL_SECONDS,
      errors: [],
    });
    expect(
      readStorageCleanupSettings({ STORAGE_CLEANUP_INTERVAL_SECONDS: '60' })
        .intervalSeconds,
    ).toBe(60);
  });
  it.each(['10', '1.5', 'abc', '100000'])('rejects %s', (v) => {
    expect(
      readStorageCleanupSettings({ STORAGE_CLEANUP_INTERVAL_SECONDS: v })
        .errors,
    ).toHaveLength(1);
  });
  it('backs off 1, 2, 4 … minutes, capped at 60', () => {
    expect(
      [1, 2, 3, 4, 7, 20].map((a) => storageRetryDelayMs(a) / 60_000),
    ).toEqual([1, 2, 4, 8, 60, 60]);
  });
});

describe('StorageDeletionService', () => {
  const setup = () => {
    const db = createInMemoryPrisma();
    const storage = new FakeStorageService();
    const config = { get: () => 'false' } as any; // REMINDERS_ENABLED=false: no timer
    const service = new StorageDeletionService(
      db as any,
      storage as any,
      config,
    );
    return { db, storage, service };
  };
  const object = (storagePath: string) => ({
    storagePath,
    kind: 'DOCUMENT_FILE' as const,
    fileSize: 10,
    uploadedById: 'u1',
    projectId: 'p1',
    safeToDelete: true,
  });

  it('queue is idempotent per path', async () => {
    const { db, service } = setup();
    await service.queue(db as any, [object('p1/a/x'), object('p1/a/x')]);
    await service.queue(db as any, [object('p1/a/x')]);
    expect(db.storagePendingDeletion.rows).toHaveLength(1);
  });

  it('a row is removed only after Storage confirms; failures are recorded', async () => {
    const { db, storage, service } = setup();
    await service.queue(db as any, [object('p1/a/x')]);
    storage.failNext('remove', 2);
    expect(await service.removeNow(['p1/a/x'])).toEqual({
      status: 'PENDING_DELETION',
      pendingObjects: 1,
    });
    expect(db.storagePendingDeletion.rows[0]).toMatchObject({
      attempts: 1,
      lastError: 'STORAGE_ERROR',
    });
    expect(await service.removeNow(['p1/a/x'])).toEqual({
      status: 'REMOVED',
      pendingObjects: 0,
    });
    expect(db.storagePendingDeletion.rows).toHaveLength(0);
  });

  it('a row claimed by one run is not attempted again by a parallel run', async () => {
    const { db, storage, service } = setup();
    await service.queue(db as any, [object('p1/a/x')]);
    const later = new Date(Date.now() + 60_000);
    const [a, b] = await Promise.all([
      service.retryDue(later),
      service.retryDue(later),
    ]);
    expect(a.attempted + b.attempted).toBe(1);
    expect(storage.pathsOf('remove')).toEqual(['p1/a/x']);
  });
});
