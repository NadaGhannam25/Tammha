import { UserRole } from '@prisma/client';
import { DocumentsService } from '../documents.service';
import { AuthUser } from '@common/types/auth-user.type';

/**
 * DocumentsService ordering guarantees (Prisma, access and storage mocked).
 * The HTTP behaviour is covered in documents.integration.spec.ts.
 */
describe('DocumentsService (unit)', () => {
  const student = {
    id: 's1',
    role: UserRole.STUDENT,
    universityId: 'u1',
  } as AuthUser;
  const projectId = 'cmproj1';
  const folder = '0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0';
  const v1 = `${projectId}/${folder}/11111111-1111-1111-1111-111111111111.YS5wZGY`;
  const pdf = {
    originalname: 'b.pdf',
    mimetype: 'application/pdf',
    size: 3,
    buffer: Buffer.from('abc'),
  };

  const row = () => ({
    id: 'd1',
    title: 'T',
    description: null,
    projectId,
    category: 'GENERAL',
    fileUrl: v1,
    fileType: 'application/pdf',
    fileSize: 3,
    isPublic: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    uploadedBy: { id: 's1' },
    versions: [{ version: 1, fileUrl: v1 }],
    _count: { versions: 1 },
  });

  let order: string[];
  let prisma: any;
  let storage: any;
  let access: any;
  let notifications: any;
  let service: DocumentsService;
  let quota: any;
  let deletions: any;

  const step = (name: string, value?: unknown) =>
    jest.fn(async () => {
      order.push(name);
      return value;
    });

  beforeEach(() => {
    order = [];
    prisma = {
      document: {
        findUnique: jest.fn().mockResolvedValue(row()),
        create: step('document.create', { id: 'd1' }),
        update: step('document.update(lock)', { id: 'd1' }),
        delete: step('document.delete'),
      },
      documentVersion: {
        findFirst: step('version.findFirst(latest)', { version: 1 }),
        create: step('version.create'),
        deleteMany: step('version.deleteMany'),
      },
    };
    prisma.$transaction = jest.fn(async (fn: any) => {
      order.push('tx.begin');
      const result = await fn(prisma);
      order.push('tx.commit');
      return result;
    });
    storage = {
      upload: step('storage.upload'),
      remove: step('storage.remove'),
    };
    access = {
      assertStudentOfProject: jest
        .fn()
        .mockResolvedValue({ id: projectId, teamId: 't1' }),
      // P08: supervisors are notified about new submissions (no supervisor here)
      getProjectSupervisorIds: jest.fn().mockResolvedValue([]),
      // P16: only the uploader or the team leader manages a document
      isLeaderOfTeam: jest.fn().mockResolvedValue(true),
    };
    notifications = { notify: jest.fn().mockResolvedValue(undefined) };
    quota = {
      assertCanStore: jest.fn(async () => order.push('quota.check')),
      reserveInTransaction: jest.fn(async () => order.push('quota.reserve')),
    };
    // StorageDeletionService has its own spec; here it forwards to the storage mock
    deletions = {
      queue: jest.fn(async () => order.push('pending.queue')),
      removeNow: jest.fn(async (paths: string[]) => {
        await storage.remove(paths);
        return { status: 'REMOVED', pendingObjects: 0 };
      }),
      removeAfterFailedWrite: jest.fn(async (o: any) =>
        storage.remove([o.storagePath]),
      ),
    };
    service = new DocumentsService(
      prisma,
      access,
      storage,
      notifications,
      quota,
      deletions,
    );
  });

  it('new version: quota check, upload, then quota lock and the document row lock BEFORE reading the latest number', async () => {
    await service.createVersion(student, 'd1', pdf);
    expect(order).toEqual([
      'quota.check',
      'storage.upload',
      'tx.begin',
      'quota.reserve',
      'document.update(lock)',
      'version.findFirst(latest)',
      'version.create',
      'tx.commit',
    ]);
    expect(prisma.documentVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ documentId: 'd1', version: 2 }),
    });
  });

  it('new version: the object lands in the existing document folder', async () => {
    await service.createVersion(student, 'd1', pdf);
    const [path] = storage.upload.mock.calls[0];
    expect(path.startsWith(`${projectId}/${folder}/`)).toBe(true);
  });

  it('nothing is deleted from Storage once the transaction has committed', async () => {
    // fails AFTER the commit (re-reading the document for the response)
    prisma.document.findUnique
      .mockResolvedValueOnce(row()) // initial load
      .mockRejectedValueOnce(new Error('read after commit failed'));
    await expect(service.createVersion(student, 'd1', pdf)).rejects.toThrow(
      'read after commit failed',
    );
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('document deleted meanwhile -> 404 and the new object is removed', async () => {
    prisma.document.update = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('gone'), { code: 'P2025' }));
    const error = await service
      .createVersion(student, 'd1', pdf)
      .catch((e) => e);
    expect(error.getResponse().code).toBe('DOCUMENT_NOT_FOUND');
    expect(storage.remove).toHaveBeenCalledTimes(1);
  });

  it('delete: lock, record pending deletions and delete rows in ONE transaction, then remove the objects', async () => {
    const result = await service.remove(student, 'd1');
    expect(order).toEqual([
      'tx.begin',
      'document.update(lock)',
      'pending.queue',
      'version.deleteMany',
      'document.delete',
      'tx.commit',
      'storage.remove',
    ]);
    expect(deletions.queue.mock.calls[0][1]).toEqual([
      expect.objectContaining({
        storagePath: v1,
        kind: 'DOCUMENT_FILE',
        projectId,
        safeToDelete: true,
      }),
      expect.objectContaining({ storagePath: v1 }), // current file (deduplicated by queue)
    ]);
    expect(deletions.removeNow).toHaveBeenCalledWith([v1]);
    expect(result.storage).toEqual({ status: 'REMOVED', pendingObjects: 0 });
  });

  it('delete: if the database step fails, no file is touched', async () => {
    prisma.document.delete = jest.fn().mockRejectedValue(new Error('db down'));
    await expect(service.remove(student, 'd1')).rejects.toThrow('db down');
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('write access is checked before any storage call', async () => {
    access.assertStudentOfProject.mockRejectedValue(new Error('denied'));
    await expect(service.createVersion(student, 'd1', pdf)).rejects.toThrow(
      'denied',
    );
    await expect(service.remove(student, 'd1')).rejects.toThrow('denied');
    expect(storage.upload).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });
});
