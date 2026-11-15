import { readFileSync } from 'fs';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { PrismaService } from '@/prisma/prisma.service';
import { configureApp } from '@/app.setup';
import { testConfigModule } from '@/testing/test-env';
import {
  createInMemoryPrisma,
  InMemoryPrisma,
} from '@/testing/in-memory-prisma';
import { FakeStorageService } from '@/testing/fake-storage';
import { IntegrationsModule } from '@/integrations/integrations.module';
import { AuthModule } from '@modules/auth/auth.module';
import { UsersModule } from '@modules/users/users.module';
import { TeamsModule } from '@modules/teams/teams.module';
import { ProjectsModule } from '@modules/projects/projects.module';
import { DocumentsModule } from '@modules/documents/documents.module';
import { AISupportModule } from '@modules/ai-support/ai-support.module';
import { SupabaseStorageService } from '@modules/documents/supabase-storage.service';
import { ProjectHandbookService } from '@modules/ai-support/handbook/project-handbook.service';
import { StorageDeletionService } from '@modules/storage/storage-deletion.service';
import { storageRetryDelayMs } from '@modules/storage/storage-cleanup.config';

/**
 * Storage space is released only when Supabase Storage CONFIRMS the object was removed.
 * A failed removal keeps the object in storage_pending_deletions, still counted toward
 * the uploader's quota, until a retry succeeds. Supabase is the in-memory fake storage,
 * told to fail where needed (`failNext('remove', 2)` = the attempt and its immediate retry).
 */
const API = '/api/v1';
const GB = 1024 ** 3;
const QUOTA = 10 * GB;
const HANDBOOK_PDF = readFileSync(
  join(__dirname, 'testing/fixtures/handbook-sample.pdf'),
);
const pdf = (bytes: number) =>
  Buffer.concat([
    Buffer.from('%PDF-1.4\n'),
    Buffer.alloc(Math.max(0, bytes - 9), 32),
  ]);
const LATER = () => new Date(Date.now() + 2 * 60 * 60_000); // past any backoff (max 60 min)

describe('Storage deletion releases quota only after Supabase confirms (integration)', () => {
  let app: INestApplication;
  let db: InMemoryPrisma;
  let deletions: StorageDeletionService;
  const storage = new FakeStorageService();
  const users: Record<string, { id: string; token: string }> = {};
  const as = (k: string) => ({ Authorization: `Bearer ${users[k].token}` });
  const http = () => request(app.getHttpServer());
  let projectId: string;

  const used = async (k: string) =>
    (await http().get(`${API}/users/me/storage`).set(as(k)).expect(200)).body;
  const upload = (k: string, bytes: number, title = 'File') =>
    http()
      .post(`${API}/documents/upload`)
      .set(as(k))
      .field('projectId', projectId)
      .field('title', title)
      .attach('file', pdf(bytes), {
        filename: 'f.pdf',
        contentType: 'application/pdf',
      });
  const newVersion = (k: string, documentId: string, bytes: number) =>
    http()
      .post(`${API}/documents/${documentId}/versions`)
      .set(as(k))
      .attach('file', pdf(bytes), {
        filename: 'v.pdf',
        contentType: 'application/pdf',
      });
  const pathsOf = (documentId: string) =>
    db.documentVersion.rows
      .filter((v: any) => v.documentId === documentId)
      .map((v: any) => v.fileUrl as string);
  const pendingRows = () => db.storagePendingDeletion.rows as any[];

  async function seed(key: string) {
    const u = await db.user.create({
      data: {
        email: `${key}@test.local`,
        password: 'unused',
        firstName: key,
        role: 'STUDENT',
        universityId: 'uni-1',
        emailVerifiedAt: new Date(),
        studentNumber: `SN-${key.toUpperCase()}`,
      },
    });
    users[key] = {
      id: u!.id,
      token: app
        .get(JwtService)
        .sign({ sub: u!.id, email: u!.email, role: 'STUDENT' }),
    };
  }

  beforeAll(async () => {
    db = createInMemoryPrisma();
    const moduleRef = await Test.createTestingModule({
      imports: [
        testConfigModule(),
        IntegrationsModule,
        AuthModule,
        UsersModule,
        TeamsModule,
        ProjectsModule,
        DocumentsModule,
        AISupportModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(db)
      .overrideProvider(SupabaseStorageService)
      .useValue(storage)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    deletions = app.get(StorageDeletionService);
    for (const s of ['leader', 'member']) await seed(s);
    const res = await http()
      .post(`${API}/projects`)
      .set(as('leader'))
      .send({ name: 'Pending Project' })
      .expect(201);
    projectId = res.body.project.id;
    await http()
      .post(`${API}/teams/join`)
      .set(as('member'))
      .send({ code: res.body.invitation.code })
      .expect(200);
  });

  afterAll(async () => {
    await app?.close();
  });

  afterEach(() => storage.reset());

  // ==================================================================
  describe('documents', () => {
    it('successful deletion: Storage confirms, no pending row, the quota is released', async () => {
      const doc = await upload('member', 4000).expect(201);
      const path = pathsOf(doc.body.id)[0];
      expect((await used('member')).usedBytes).toBe(4000);

      const res = await http()
        .delete(`${API}/documents/${doc.body.id}`)
        .set(as('member'))
        .expect(200);
      expect(res.body).toEqual({
        message: 'Document deleted',
        storage: { status: 'REMOVED', pendingObjects: 0 },
      });
      expect(storage.objects.has(path)).toBe(false);
      expect(pendingRows()).toHaveLength(0);
      expect((await used('member')).usedBytes).toBe(0);
    });

    it('failed Supabase deletion: the document is gone for users, but its space is NOT released', async () => {
      const doc = await upload('member', 1000, 'Kept in storage').expect(201);
      await newVersion('member', doc.body.id, 1500).expect(201);
      const paths = pathsOf(doc.body.id);
      expect((await used('member')).usedBytes).toBe(2500);

      storage.failNext('remove', 2); // the attempt and its immediate retry both fail
      const before = Date.now();
      const res = await http()
        .delete(`${API}/documents/${doc.body.id}`)
        .set(as('member'))
        .expect(200);
      expect(res.body.storage).toEqual({
        status: 'PENDING_DELETION',
        pendingObjects: 2,
      });
      expect(res.body.message).toMatch(/could not be removed yet/);

      // gone for users …
      await http()
        .get(`${API}/documents/${doc.body.id}`)
        .set(as('member'))
        .expect(404);
      // … but the objects physically exist, so they still count (same bytes, same project)
      for (const p of paths) expect(storage.objects.has(p)).toBe(true);
      const usage = await used('member');
      expect(usage).toMatchObject({
        usedBytes: 2500,
        breakdown: { documentBytes: 2500, files: 2 },
      });
      expect(usage.projects).toEqual([
        { projectId, projectName: 'Pending Project', usedBytes: 2500 },
      ]);

      // enough information to retry later; the failure is recorded, not ignored
      const rows = pendingRows();
      expect(rows.map((r) => r.storagePath).sort()).toEqual([...paths].sort());
      for (const r of rows) {
        expect(r).toMatchObject({
          kind: 'DOCUMENT_FILE',
          status: 'PENDING',
          uploadedById: users.member.id,
          projectId,
          attempts: 1,
          lastError: 'STORAGE_ERROR',
        });
        expect(r.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
          before + storageRetryDelayMs(1),
        );
      }
    });

    it('pending space still blocks uploads that would exceed the quota', async () => {
      // 2500 pending bytes; fill the rest except 100 bytes
      const filler = await db.document.create({
        data: {
          title: 'Existing',
          projectId,
          uploadedById: users.member.id,
          fileUrl: `${projectId}/seed/filler.bin`,
          fileType: 'application/octet-stream',
          fileSize: 0,
        },
      });
      const fillerBytes = QUOTA - 2500 - 100;
      let v = 0;
      for (let left = fillerBytes; left > 0;) {
        const size = Math.min(left, 2_000_000_000);
        await db.documentVersion.create({
          data: {
            documentId: filler!.id,
            fileUrl: `${projectId}/seed/filler-${++v}.bin`,
            version: v,
            fileSize: size,
            uploadedById: users.member.id,
          },
        });
        left -= size;
      }
      const res = await upload('member', 500).expect(409);
      expect(res.body).toMatchObject({
        code: 'STORAGE_QUOTA_EXCEEDED',
        details: { usedBytes: QUOTA - 100, remainingBytes: 100 },
      });
      await db.documentVersion.deleteMany({
        where: { documentId: filler!.id },
      });
      await db.document.delete({ where: { id: filler!.id } });
    });

    it('retrying: not before its time, still pending while Storage fails, released once it succeeds', async () => {
      const rows = pendingRows();
      const paths = rows.map((r) => r.storagePath);
      for (const p of paths)
        storage.objects.set(p, {
          size: 1,
          contentType: 'x',
          body: Buffer.from('x'),
        });

      // not due yet: nothing is attempted
      expect(await deletions.retryDue(new Date())).toEqual({
        attempted: 0,
        removed: 0,
        failed: 0,
      });

      // due, Storage still failing: still pending and still counted, attempts grow
      storage.failNext('remove', 2);
      expect(await deletions.retryDue(LATER())).toEqual({
        attempted: 2,
        removed: 0,
        failed: 2,
      });
      expect(pendingRows().every((r) => r.attempts === 2)).toBe(true);
      expect((await used('member')).usedBytes).toBe(2500);

      // Storage works again: removed, rows gone, quota released
      expect(
        await deletions.retryDue(new Date(LATER().getTime() + 60 * 60_000)),
      ).toEqual({
        attempted: 2,
        removed: 2,
        failed: 0,
      });
      for (const p of paths) expect(storage.objects.has(p)).toBe(false);
      expect(pendingRows()).toHaveLength(0);
      expect((await used('member')).usedBytes).toBe(0);
    });

    it('document versions: each version stays charged to its own uploader until removed', async () => {
      const doc = await upload('member', 1000, 'Shared doc').expect(201);
      await newVersion('leader', doc.body.id, 700).expect(201); // leader's own quota
      expect((await used('member')).usedBytes).toBe(1000);
      expect((await used('leader')).usedBytes).toBe(700);

      storage.failNext('remove', 2);
      const res = await http()
        .delete(`${API}/documents/${doc.body.id}`)
        .set(as('leader'))
        .expect(200);
      expect(res.body.storage).toEqual({
        status: 'PENDING_DELETION',
        pendingObjects: 2,
      });
      expect((await used('member')).usedBytes).toBe(1000);
      expect((await used('leader')).usedBytes).toBe(700);

      await deletions.runOnce(); // background job: not due yet
      expect(pendingRows()).toHaveLength(2);
      await deletions.retryDue(LATER());
      expect((await used('member')).usedBytes).toBe(0);
      expect((await used('leader')).usedBytes).toBe(0);
    });

    it('a failed upload whose cleanup also fails stays counted for the uploader until removed', async () => {
      storage.failNext('remove', 2);
      const spy = jest
        .spyOn(db.document, 'create')
        .mockRejectedValueOnce(new Error('db down'));
      await upload('member', 1234, 'Half written').expect(500);
      spy.mockRestore();
      expect(
        db.document.rows.some((d: any) => d.title === 'Half written'),
      ).toBe(false);

      const [row] = pendingRows();
      expect(row).toMatchObject({
        kind: 'DOCUMENT_FILE',
        status: 'PENDING',
        fileSize: 1234,
        uploadedById: users.member.id,
        attempts: 1,
        lastError: 'STORAGE_DELETE_FAILED',
      });
      expect(storage.objects.has(row.storagePath)).toBe(true);
      expect((await used('member')).usedBytes).toBe(1234);

      await deletions.retryDue(LATER());
      expect(storage.objects.has(row.storagePath)).toBe(false);
      expect((await used('member')).usedBytes).toBe(0);
    });

    it('a path outside the project folder is never deleted automatically and stays counted', async () => {
      const doc = await upload('member', 300, 'Corrupted').expect(201);
      const foreign = 'another-project/folder/file.pdf';
      storage.objects.set(foreign, {
        size: 50,
        contentType: 'x',
        body: Buffer.alloc(50),
      });
      await db.documentVersion.create({
        data: {
          documentId: doc.body.id,
          fileUrl: foreign,
          version: 2,
          fileSize: 50,
          uploadedById: users.member.id,
        },
      });
      const res = await http()
        .delete(`${API}/documents/${doc.body.id}`)
        .set(as('member'))
        .expect(200);
      expect(res.body.storage).toEqual({
        status: 'PENDING_DELETION',
        pendingObjects: 1,
      });
      expect(storage.pathsOf('remove')).not.toContain(foreign);
      expect(storage.objects.has(foreign)).toBe(true);
      expect(pendingRows()).toEqual([
        expect.objectContaining({
          storagePath: foreign,
          status: 'BLOCKED',
          lastError: 'OUTSIDE_EXPECTED_FOLDER',
        }),
      ]);
      expect((await used('member')).usedBytes).toBe(50);
      expect(await deletions.retryDue(LATER())).toMatchObject({ attempted: 0 });
      await db.storagePendingDeletion.deleteMany({}); // manual check done (test cleanup)
    });
  });

  // ==================================================================
  describe('project handbook versions', () => {
    const base = () => `${API}/projects/${projectId}/handbook`;

    async function uploadHandbook(body: Buffer) {
      await http()
        .put(base())
        .set(as('leader'))
        .attach('file', body, {
          filename: 'h.pdf',
          contentType: 'application/pdf',
        })
        .expect(202);
      await app.get(ProjectHandbookService).whenIdle();
    }

    it('successful deletion releases the version size', async () => {
      await uploadHandbook(HANDBOOK_PDF); // READY + active
      const broken = Buffer.from('%PDF-1.4 not a real pdf');
      await uploadHandbook(broken); // FAILED
      const failed = db.projectHandbook.rows.find(
        (h: any) => h.status === 'FAILED',
      )!;
      const before = (await used('leader')).usedBytes;

      const res = await http()
        .delete(`${base()}/versions/${failed.id}`)
        .set(as('leader'))
        .expect(200);
      expect(res.body).toEqual({
        deleted: true,
        releasedBytes: broken.length,
        storage: { status: 'REMOVED', pendingObjects: 0 },
      });
      expect((await used('leader')).usedBytes).toBe(before - broken.length);
      expect(pendingRows()).toHaveLength(0);
    });

    it('failed Supabase deletion keeps the handbook PDF counted; a retry releases it', async () => {
      const broken = Buffer.from('%PDF-1.4 also not a real pdf');
      await uploadHandbook(broken);
      const failed = db.projectHandbook.rows.find(
        (h: any) => h.status === 'FAILED',
      )!;
      storage.objects.set(failed.storagePath, {
        size: broken.length,
        contentType: 'application/pdf',
        body: broken,
      });
      const before = await used('leader');

      storage.failNext('remove', 2);
      const res = await http()
        .delete(`${base()}/versions/${failed.id}`)
        .set(as('leader'))
        .expect(200);
      expect(res.body).toEqual({
        deleted: true,
        releasedBytes: 0,
        storage: { status: 'PENDING_DELETION', pendingObjects: 1 },
      });
      // removed from the version list …
      const versions = await http()
        .get(`${base()}/versions`)
        .set(as('leader'))
        .expect(200);
      expect(JSON.stringify(versions.body)).not.toContain(failed.id);
      // … but still stored and still counted as handbook bytes
      expect(storage.objects.has(failed.storagePath)).toBe(true);
      const during = await used('leader');
      expect(during.usedBytes).toBe(before.usedBytes);
      expect(during.breakdown.handbookBytes).toBe(
        before.breakdown.handbookBytes,
      );
      expect(pendingRows()).toEqual([
        expect.objectContaining({
          storagePath: failed.storagePath,
          kind: 'PROJECT_HANDBOOK',
          fileSize: broken.length,
          uploadedById: users.leader.id,
          attempts: 1,
        }),
      ]);

      expect(await deletions.retryDue(LATER())).toEqual({
        attempted: 1,
        removed: 1,
        failed: 0,
      });
      expect(storage.objects.has(failed.storagePath)).toBe(false);
      expect((await used('leader')).usedBytes).toBe(
        before.usedBytes - broken.length,
      );
    });

    it('a failed handbook upload whose cleanup also fails stays counted until removed', async () => {
      const before = (await used('leader')).usedBytes;
      storage.failNext('remove', 2);
      const spy = jest
        .spyOn(db.projectHandbook, 'create')
        .mockRejectedValueOnce(new Error('db down'));
      await http()
        .put(base())
        .set(as('leader'))
        .attach('file', HANDBOOK_PDF, {
          filename: 'h.pdf',
          contentType: 'application/pdf',
        })
        .expect(500);
      spy.mockRestore();
      expect(pendingRows()).toEqual([
        expect.objectContaining({
          kind: 'PROJECT_HANDBOOK',
          fileSize: HANDBOOK_PDF.length,
          uploadedById: users.leader.id,
        }),
      ]);
      expect((await used('leader')).usedBytes).toBe(
        before + HANDBOOK_PDF.length,
      );
      await deletions.retryDue(LATER());
      expect((await used('leader')).usedBytes).toBe(before);
    });
  });
});
