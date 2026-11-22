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

/**
 * Student storage quota with the DEFAULT limit (10 GB = 10 × 1024³ bytes), one quota per
 * student shared by all their projects. Large existing usage is seeded as file metadata
 * (exactly what the quota reads); real uploads go through the API and the fake storage.
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

describe('Student storage quota (integration)', () => {
  let app: INestApplication;
  let db: InMemoryPrisma;
  const storage = new FakeStorageService();
  const users: Record<string, { id: string; token: string }> = {};
  const as = (k: string) => ({ Authorization: `Bearer ${users[k].token}` });
  const http = () => request(app.getHttpServer());
  const projects: Record<
    string,
    { projectId: string; teamId: string; code: string }
  > = {};

  const usage = async (k: string) =>
    (await http().get(`${API}/users/me/storage`).set(as(k)).expect(200)).body;
  const upload = (
    k: string,
    projectId: string,
    bytes: number,
    title = 'File',
  ) =>
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

  /** Files uploaded earlier (metadata only): `bytes` charged to `k` in `projectId`. */
  async function seedUsage(k: string, projectId: string, bytes: number) {
    const doc = await db.document.create({
      data: {
        title: 'Existing large files',
        projectId,
        uploadedById: users[k].id,
        fileUrl: `${projectId}/seed/${Math.random()}.bin`,
        fileType: 'application/octet-stream',
        fileSize: 0,
        category: 'GENERAL',
      },
    });
    let version = 0;
    for (let left = bytes; left > 0;) {
      const size = Math.min(left, 2_000_000_000); // INT column
      await db.documentVersion.create({
        data: {
          documentId: doc!.id,
          fileUrl: `${projectId}/seed/${doc!.id}-${++version}.bin`,
          version,
          fileSize: size,
          uploadedById: users[k].id,
        },
      });
      left -= size;
    }
    return doc!.id;
  }

  async function seed(key: string, role: string) {
    const u = await db.user.create({
      data: {
        email: `${key}@test.local`,
        password: 'unused',
        firstName: key,
        role,
        universityId: 'uni-1',
        emailVerifiedAt: new Date(),
        ...(role === 'STUDENT' && { studentNumber: `SN-${key.toUpperCase()}` }),
      },
    });
    users[key] = {
      id: u!.id,
      token: app.get(JwtService).sign({ sub: u!.id, email: u!.email, role }),
    };
  }
  async function createProject(k: string, name: string) {
    const res = await http()
      .post(`${API}/projects`)
      .set(as(k))
      .send({ name })
      .expect(201);
    projects[name] = {
      projectId: res.body.project.id,
      teamId: res.body.team.id,
      code: res.body.invitation.code,
    };
  }

  beforeAll(async () => {
    db = createInMemoryPrisma();
    const moduleRef = await Test.createTestingModule({
      imports: [
        testConfigModule(), // STUDENT_STORAGE_QUOTA_GB not set: the default 10 GB applies
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
    for (const s of ['alice', 'bob', 'carol', 'dina']) await seed(s, 'STUDENT');
    await seed('supA', 'SUPERVISOR');
    await createProject('alice', 'Project A'); // alice leads A; bob joins A
    await http()
      .post(`${API}/teams/join`)
      .set(as('bob'))
      .send({ code: projects['Project A'].code })
      .expect(200);
    await createProject('carol', 'Project B'); // carol leads B
  });

  afterAll(async () => {
    await app?.close();
  });

  // ==================================================================
  it('starts empty with the 10 GB default quota', async () => {
    expect(await usage('alice')).toEqual({
      quotaApplies: true,
      usedBytes: 0,
      quotaBytes: QUOTA,
      remainingBytes: QUOTA,
      percentageUsed: 0,
      status: 'NORMAL',
      thresholds: { warningAt: 0.8, criticalAt: 0.95 },
      breakdown: {
        documentBytes: 0,
        handbookBytes: 0,
        files: 0,
        filesWithUnknownSize: 0,
      },
      projects: [],
    });
  });

  it('a student below the quota can upload; the file counts in bytes', async () => {
    const res = await upload(
      'alice',
      projects['Project A'].projectId,
      4000,
    ).expect(201);
    const u = await usage('alice');
    expect(u).toMatchObject({
      usedBytes: 4000,
      remainingBytes: QUOTA - 4000,
      status: 'NORMAL',
    });
    expect(u.projects).toEqual([
      {
        projectId: projects['Project A'].projectId,
        projectName: 'Project A',
        usedBytes: 4000,
      },
    ]);
    expect(res.body.fileSize).toBe(4000);
  });

  it('document versions count toward the uploader', async () => {
    const doc = await upload(
      'bob',
      projects['Project A'].projectId,
      1000,
      'Report',
    ).expect(201);
    await newVersion('bob', doc.body.id, 1500).expect(201);
    await newVersion('bob', doc.body.id, 2500).expect(201);
    expect(await usage('bob')).toMatchObject({
      usedBytes: 5000,
      breakdown: { documentBytes: 5000, files: 3 },
    });
  });

  it("a leader adding a version to a member's document uses her OWN quota", async () => {
    const before = (await usage('bob')).usedBytes;
    const doc = db.document.rows.find((d: any) => d.title === 'Report')!;
    await newVersion('alice', doc.id, 700).expect(201);
    expect((await usage('bob')).usedBytes).toBe(before);
    expect((await usage('alice')).usedBytes).toBe(4700);
  });

  it('different students have independent quotas', async () => {
    expect((await usage('carol')).usedBytes).toBe(0);
    expect((await usage('dina')).usedBytes).toBe(0);
  });

  it('one quota is shared across all projects of the student', async () => {
    // bob leaves A and joins B; his files in A still count, new ones in B add up
    await http()
      .delete(
        `${API}/teams/${projects['Project A'].teamId}/members/${users.bob.id}`,
      )
      .set(as('bob'))
      .expect(200);
    await http()
      .post(`${API}/teams/join`)
      .set(as('bob'))
      .send({ code: projects['Project B'].code })
      .expect(200);
    await upload(
      'bob',
      projects['Project B'].projectId,
      3000,
      'B notes',
    ).expect(201);
    const u = await usage('bob');
    expect(u.usedBytes).toBe(8000);
    expect(u.projects).toEqual([
      {
        projectId: projects['Project A'].projectId,
        projectName: 'Project A',
        usedBytes: 5000,
      },
      {
        projectId: projects['Project B'].projectId,
        projectName: 'Project B',
        usedBytes: 3000,
      },
    ]);
    // large existing files in B: 2 GB + 3 GB = shared 5 GB (+8000 bytes)
    await seedUsage('bob', projects['Project B'].projectId, 2 * GB);
    await seedUsage('bob', projects['Project B'].projectId, 3 * GB);
    expect((await usage('bob')).usedBytes).toBe(5 * GB + 8000);
  });

  it('an upload that would exceed 10 GB is refused BEFORE storing, with safe details', async () => {
    const used = (await usage('bob')).usedBytes;
    await seedUsage(
      'bob',
      projects['Project B'].projectId,
      QUOTA - used - 1000,
    ); // 1000 bytes left
    const objects = storage.objects.size;
    const documents = db.document.rows.length;
    const res = await upload(
      'bob',
      projects['Project B'].projectId,
      2000,
    ).expect(409);
    expect(res.body).toMatchObject({
      code: 'STORAGE_QUOTA_EXCEEDED',
      details: {
        usedBytes: QUOTA - 1000,
        quotaBytes: QUOTA,
        remainingBytes: 1000,
        requestedBytes: 2000,
      },
    });
    expect(storage.objects.size).toBe(objects);
    expect(db.document.rows.length).toBe(documents);
    expect(JSON.stringify(res.body)).not.toContain(users.bob.id);
  });

  it('new versions are refused too; an upload that fits exactly is accepted', async () => {
    const doc = db.document.rows.find((d: any) => d.title === 'B notes')!;
    const res = await newVersion('bob', doc.id, 1500).expect(409);
    expect(res.body.code).toBe('STORAGE_QUOTA_EXCEEDED');
    expect(
      db.documentVersion.rows.filter((v: any) => v.documentId === doc.id),
    ).toHaveLength(1);
    await upload(
      'bob',
      projects['Project B'].projectId,
      1000,
      'Last bytes',
    ).expect(201);
    expect(await usage('bob')).toMatchObject({
      usedBytes: QUOTA,
      remainingBytes: 0,
      percentageUsed: 100,
      status: 'FULL',
    });
    await upload('bob', projects['Project B'].projectId, 10).expect(409);
  });

  it('at 100% the student can still list, view, download and delete files; deleting releases storage', async () => {
    const list = await http()
      .get(`${API}/documents?projectId=${projects['Project B'].projectId}`)
      .set(as('bob'))
      .expect(200);
    const last = list.body.find((d: any) => d.title === 'Last bytes');
    const one = await http()
      .get(`${API}/documents/${last.id}`)
      .set(as('bob'))
      .expect(200);
    expect(one.body.signedUrl).toEqual(expect.any(String));
    expect(one.body.downloadUrl).toEqual(expect.any(String));
    await http()
      .get(`${API}/documents/${last.id}/versions`)
      .set(as('bob'))
      .expect(200);

    await http()
      .delete(`${API}/documents/${last.id}`)
      .set(as('bob'))
      .expect(200);
    expect(await usage('bob')).toMatchObject({
      usedBytes: QUOTA - 1000,
      remainingBytes: 1000,
    });

    // deleting a document releases ALL its versions, each from its own uploader
    // (bob left Project A, so its leader alice deletes bob's 'Report' there)
    const report = db.document.rows.find((d: any) => d.title === 'Report')!;
    const aliceBefore = (await usage('alice')).usedBytes;
    await http()
      .delete(`${API}/documents/${report.id}`)
      .set(as('alice'))
      .expect(200);
    expect((await usage('bob')).usedBytes).toBe(QUOTA - 1000 - 5000);
    expect((await usage('alice')).usedBytes).toBe(aliceBefore - 700);
  });

  it('warning states follow the thresholds', async () => {
    await seedUsage(
      'dina',
      projects['Project B'].projectId,
      Math.ceil(QUOTA * 0.8),
    );
    expect(await usage('dina')).toMatchObject({
      status: 'WARNING',
      percentageUsed: 80,
    });
    await seedUsage(
      'dina',
      projects['Project B'].projectId,
      Math.ceil(QUOTA * 0.15),
    );
    expect((await usage('dina')).status).toBe('CRITICAL');
  });

  // ==================================================================
  describe('project handbook', () => {
    const handbooks = () => app.get(ProjectHandbookService);

    it("the leader's handbook PDF counts toward her usage (failed versions too, until deleted)", async () => {
      const before = await usage('carol');
      await http()
        .put(`${API}/projects/${projects['Project B'].projectId}/handbook`)
        .set(as('carol'))
        .attach('file', HANDBOOK_PDF, {
          filename: 'h.pdf',
          contentType: 'application/pdf',
        })
        .expect(202);
      await handbooks().whenIdle();
      const broken = Buffer.from('%PDF-1.4 not really a pdf');
      await http()
        .put(`${API}/projects/${projects['Project B'].projectId}/handbook`)
        .set(as('carol'))
        .attach('file', broken, {
          filename: 'b.pdf',
          contentType: 'application/pdf',
        })
        .expect(202);
      await handbooks().whenIdle();
      const after = await usage('carol');
      expect(after.usedBytes).toBe(
        before.usedBytes + HANDBOOK_PDF.length + broken.length,
      );
      expect(after.breakdown.handbookBytes).toBe(
        HANDBOOK_PDF.length + broken.length,
      );
      // bob (member) uploaded nothing here: unchanged
      expect((await usage('bob')).breakdown.handbookBytes).toBe(0);
    });

    it('deleting an old/failed handbook version releases its storage; the active one cannot be deleted', async () => {
      const rows = db.projectHandbook.rows.filter(
        (h: any) => h.projectId === projects['Project B'].projectId,
      );
      const failed = rows.find((h: any) => h.status === 'FAILED')!;
      const active = rows.find((h: any) => h.isActive)!;
      const base = `${API}/projects/${projects['Project B'].projectId}/handbook/versions`;
      const blocked = await http()
        .delete(`${base}/${active.id}`)
        .set(as('carol'))
        .expect(409);
      expect(blocked.body.code).toBe('HANDBOOK_ACTIVE_VERSION');
      // a student of another team cannot (any student of Project B can)
      await http().delete(`${base}/${failed.id}`).set(as('alice')).expect(403);
      const before = (await usage('carol')).usedBytes;
      const res = await http()
        .delete(`${base}/${failed.id}`)
        .set(as('carol'))
        .expect(200);
      expect(res.body).toEqual({
        deleted: true,
        releasedBytes: failed.fileSize,
        storage: { status: 'REMOVED', pendingObjects: 0 },
      });
      expect((await usage('carol')).usedBytes).toBe(before - failed.fileSize);
      expect(storage.objects.has(failed.storagePath)).toBe(false);
    });

    it('a handbook upload that would exceed the quota is refused before storing', async () => {
      await seedUsage(
        'carol',
        projects['Project B'].projectId,
        QUOTA - (await usage('carol')).usedBytes - 10,
      );
      const objects = storage.objects.size;
      const res = await http()
        .put(`${API}/projects/${projects['Project B'].projectId}/handbook`)
        .set(as('carol'))
        .attach('file', HANDBOOK_PDF, {
          filename: 'h.pdf',
          contentType: 'application/pdf',
        })
        .expect(409);
      expect(res.body).toMatchObject({
        code: 'STORAGE_QUOTA_EXCEEDED',
        details: { remainingBytes: 10, requestedBytes: HANDBOOK_PDF.length },
      });
      expect(storage.objects.size).toBe(objects);
    });
  });

  // ==================================================================
  it('supervisors have no student quota', async () => {
    expect(await usage('supA')).toMatchObject({
      quotaApplies: false,
      quotaBytes: null,
      remainingBytes: null,
      percentageUsed: null,
      status: 'NOT_LIMITED',
    });
  });

  it('older versions without a recorded size are reported, not guessed', async () => {
    const docId = await seedUsage(
      'alice',
      projects['Project A'].projectId,
      100,
    );
    await db.documentVersion.create({
      data: {
        documentId: docId,
        fileUrl: `${projects['Project A'].projectId}/seed/legacy.bin`,
        version: 99,
        fileSize: null,
        uploadedById: users.alice.id,
      },
    });
    expect((await usage('alice')).breakdown.filesWithUnknownSize).toBe(1);
  });
});
