import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { PrismaService } from '@/prisma/prisma.service';
import { configureApp, createSwaggerDocument } from '@/app.setup';
import { testConfigModule } from '@/testing/test-env';
import {
  createInMemoryPrisma,
  InMemoryPrisma,
} from '@/testing/in-memory-prisma';
import { FakeStorageService } from '@/testing/fake-storage';
import { AuthModule } from '@modules/auth/auth.module';
import { ProjectsModule } from '@modules/projects/projects.module';
import { TeamsModule } from '@modules/teams/teams.module';
import { DocumentsModule } from '@modules/documents/documents.module';
import { SupabaseStorageService } from '@modules/documents/supabase-storage.service';
import { MAX_FILE_SIZE_BYTES } from '@modules/documents/document-files';

/**
 * HTTP integration tests for P07 documents.
 * Real: controller, multer, DocumentsService, JWT/Roles guards, workspace access,
 * ValidationPipe, error filter. Replaced: Prisma (in-memory) and Supabase Storage
 * (FakeStorageService) — no request ever reaches Supabase.
 */
describe('Documents (integration)', () => {
  let app: INestApplication;
  let db: InMemoryPrisma;
  let storage: FakeStorageService;
  let jwt: JwtService;

  const API = '/api/v1';
  const users: Record<string, { id: string; token: string }> = {};
  const as = (key: string) => ({ Authorization: `Bearer ${users[key].token}` });
  const http = () => request(app.getHttpServer());

  /** Supabase Storage key rule (supabase/storage src/storage/limits.ts isValidKey). */
  const SUPABASE_VALID_KEY =
    /^(\w|\/|!|-|\.|\*|'|\(|\)| |&|\$|@|=|;|:|\+|,|\?)*$/;
  const ARABIC_NAME = 'تقرير المشروع.pdf';
  const PDF = Buffer.from('%PDF-1.4 fake test document');

  let projectA = '';
  let projectB = '';

  async function seedUser(key: string, role: string) {
    const u = await db.user.create({
      data: {
        email: `${key}@test.local`,
        password: 'unused',
        firstName: key,
        role,
        // students need a university identity (student number or verified university e-mail)
        studentNumber: role === 'STUDENT' ? `SN-${key.toUpperCase()}` : null,
        universityId: 'uni-1',
      },
    });
    users[key] = {
      id: u!.id,
      token: jwt.sign({ sub: u!.id, email: u!.email, role }),
    };
  }

  const uploadAs = (
    who: string,
    fields: Record<string, string>,
    file?: { name: string; body: Buffer; type?: string },
  ) => {
    let req = http().post(`${API}/documents/upload`).set(as(who));
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    if (file)
      req = req.attach('file', file.body, {
        filename: file.name,
        contentType: file.type ?? 'application/pdf',
      });
    return req;
  };

  const versionAs = (
    who: string,
    id: string,
    file?: { name: string; body: Buffer; type?: string },
  ) => {
    let req = http().post(`${API}/documents/${id}/versions`).set(as(who));
    if (file)
      req = req.attach('file', file.body, {
        filename: file.name,
        contentType: file.type ?? 'application/pdf',
      });
    return req;
  };

  beforeAll(async () => {
    db = createInMemoryPrisma();
    storage = new FakeStorageService();
    const moduleRef = await Test.createTestingModule({
      imports: [
        testConfigModule(),
        AuthModule,
        TeamsModule,
        ProjectsModule,
        DocumentsModule,
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
    jwt = app.get(JwtService);

    for (const s of ['alice', 'bob', 'erin']) await seedUser(s, 'STUDENT');
    await seedUser('supA', 'SUPERVISOR');
    await seedUser('supB', 'SUPERVISOR');
    await seedUser('admin', 'ADMIN');

    // Project A: alice (LEADER) + bob (MEMBER). Project B: erin. supA supervises A.
    const a = await http()
      .post(`${API}/projects`)
      .set(as('alice'))
      .send({ name: 'Project A' })
      .expect(201);
    projectA = a.body.project.id;
    await http()
      .post(`${API}/teams/join`)
      .set(as('bob'))
      .send({ code: a.body.invitation.code })
      .expect(200);
    const b = await http()
      .post(`${API}/projects`)
      .set(as('erin'))
      .send({ name: 'Project B' })
      .expect(201);
    projectB = b.body.project.id;
    const req = await http()
      .post(`${API}/projects/${projectA}/supervision-requests`)
      .set(as('alice'))
      .send({ supervisorEmail: 'supA@test.local' })
      .expect(201);
    await http()
      .post(`${API}/supervision-requests/${req.body.id}/accept`)
      .set(as('supA'))
      .send({})
      .expect(200);
  });

  afterAll(async () => {
    await app?.close();
  });

  const state = { docId: '', v1Path: '', v2Path: '', docB: '' };

  // ==================================================================
  describe('JWT protection', () => {
    it.each([
      ['post', '/documents/upload'],
      ['get', '/documents'],
      ['get', '/documents/x'],
      ['patch', '/documents/x'],
      ['get', '/documents/x/versions'],
      ['post', '/documents/x/versions'],
      ['delete', '/documents/x'],
    ])('%s %s -> 401 without token', async (method, path) => {
      await (http() as any)[method](`${API}${path}`).expect(401);
    });

    it('ADMIN gets no project access through documents', async () => {
      await http().get(`${API}/documents`).set(as('admin')).expect(403);
    });

    it('Swagger documents all 7 routes', () => {
      const paths = createSwaggerDocument(app).paths;
      expect(Object.keys(paths)).toEqual(
        expect.arrayContaining([
          `${API}/documents/upload`,
          `${API}/documents`,
          `${API}/documents/{id}`,
          `${API}/documents/{id}/versions`,
        ]),
      );
    });
  });

  // ==================================================================
  describe('Upload (version 1)', () => {
    it('student uploads: Document + DocumentVersion 1 + project-scoped storage object', async () => {
      const res = await uploadAs(
        'bob', // MEMBER label: TeamRole grants nothing and takes nothing
        {
          projectId: projectA,
          title: '  Chapter 3  ',
          description: 'Design',
          category: 'REPORT',
        },
        { name: ARABIC_NAME, body: PDF },
      ).expect(201);

      state.docId = res.body.id;
      expect(res.body).toMatchObject({
        title: 'Chapter 3',
        description: 'Design',
        category: 'REPORT',
        projectId: projectA,
        fileName: ARABIC_NAME, // Arabic preserved (multer latin1 decoding repaired)
        fileType: 'application/pdf',
        fileSize: PDF.length,
        isPublic: false,
        currentVersion: 1,
        versionCount: 1,
        uploadedBy: { id: users.bob.id },
      });
      expect(JSON.stringify(res.body)).not.toContain('password');

      // storage: exactly one upload, scoped to <projectId>/<documentFolder>/<object>
      const uploaded = storage.pathsOf('upload');
      expect(uploaded).toHaveLength(1);
      state.v1Path = uploaded[0];
      const [proj, folder, object] = state.v1Path.split('/');
      expect(proj).toBe(projectA);
      expect(folder).toMatch(/^[0-9a-f-]{36}$/);
      expect(object).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]+$/);
      expect(state.v1Path).toMatch(SUPABASE_VALID_KEY); // ASCII-only key accepted by Supabase
      expect(storage.objects.get(state.v1Path)).toMatchObject({
        size: PDF.length,
        contentType: 'application/pdf',
      });

      // database
      const doc = db.document.rows.find((d) => d.id === state.docId)!;
      expect(doc).toMatchObject({
        fileUrl: state.v1Path,
        projectId: projectA,
        uploadedById: users.bob.id,
      });
      const versions = db.documentVersion.rows.filter(
        (v) => v.documentId === state.docId,
      );
      expect(versions).toEqual([
        expect.objectContaining({ version: 1, fileUrl: state.v1Path }),
      ]);
    });

    it('missing file -> 400 FILE_REQUIRED, nothing stored', async () => {
      storage.calls.length = 0;
      const res = await uploadAs('alice', {
        projectId: projectA,
        title: 'No file',
      }).expect(400);
      expect(res.body.code).toBe('FILE_REQUIRED');
      expect(storage.pathsOf('upload')).toEqual([]);
    });

    it('empty file -> 400 FILE_EMPTY', async () => {
      const res = await uploadAs(
        'alice',
        { projectId: projectA, title: 'Empty' },
        { name: 'a.pdf', body: Buffer.alloc(0) },
      ).expect(400);
      expect(res.body.code).toBe('FILE_EMPTY');
    });

    it('invalid DTO -> 400 (missing title, blank title, bad category, unknown field, long title)', async () => {
      const file = { name: 'a.pdf', body: PDF };
      await uploadAs('alice', { projectId: projectA }, file).expect(400);
      await uploadAs(
        'alice',
        { projectId: projectA, title: '   ' },
        file,
      ).expect(400);
      await uploadAs(
        'alice',
        { projectId: projectA, title: 'X', category: 'SECRET' },
        file,
      ).expect(400);
      await uploadAs(
        'alice',
        { projectId: projectA, title: 'X', bucket: 'public' },
        file,
      ).expect(400);
      await uploadAs(
        'alice',
        { projectId: projectA, title: 'x'.repeat(201) },
        file,
      ).expect(400);
      await uploadAs('alice', { title: 'No project' }, file).expect(400);
    });

    it('executables are rejected, including double extensions', async () => {
      for (const name of [
        'setup.exe',
        'report.pdf.exe',
        'run.BAT',
        'app.jar',
        'x.msi',
      ]) {
        const res = await uploadAs(
          'alice',
          { projectId: projectA, title: 'Bad' },
          { name, body: PDF, type: 'application/octet-stream' },
        ).expect(400);
        expect(res.body.code).toBe('FILE_TYPE_NOT_ALLOWED');
      }
    });

    it('source code is allowed; HTML is stored as a download (not rendered)', async () => {
      await uploadAs(
        'alice',
        { projectId: projectA, title: 'Code', category: 'CODE' },
        {
          name: 'main.py',
          body: Buffer.from('print(1)'),
          type: 'text/x-python',
        },
      ).expect(201);
      const html = await uploadAs(
        'alice',
        { projectId: projectA, title: 'Page', category: 'CODE' },
        {
          name: 'index.html',
          body: Buffer.from('<h1>x</h1>'),
          type: 'text/html',
        },
      ).expect(201);
      expect(html.body.fileType).toBe('text/html'); // what the user uploaded
      const stored = storage.objects.get(
        db.document.rows.find((d) => d.id === html.body.id)!.fileUrl,
      )!;
      expect(stored.contentType).toBe('application/octet-stream'); // what Storage serves
    });

    it('path traversal in the file name cannot leave the document folder', async () => {
      const res = await uploadAs(
        'alice',
        { projectId: projectA, title: 'Traversal' },
        { name: '../../../etc/passwd.pdf', body: PDF },
      ).expect(201);
      expect(res.body.fileName).toBe('passwd.pdf');
      const path = db.document.rows.find((d) => d.id === res.body.id)!
        .fileUrl as string;
      expect(path.split('/')).toHaveLength(3);
      expect(path.startsWith(`${projectA}/`)).toBe(true);
      expect(path).not.toContain('..');
    });

    it('student outside the project -> 403 PROJECT_ACCESS_DENIED, nothing stored', async () => {
      storage.calls.length = 0;
      const res = await uploadAs(
        'erin',
        { projectId: projectA, title: 'Intruder' },
        { name: 'a.pdf', body: PDF },
      ).expect(403);
      expect(res.body.code).toBe('PROJECT_ACCESS_DENIED');
      expect(storage.pathsOf('upload')).toEqual([]);
    });

    it('supervisors cannot upload (even to a supervised project)', async () => {
      await uploadAs(
        'supA',
        { projectId: projectA, title: 'Sup' },
        { name: 'a.pdf', body: PDF },
      ).expect(403);
    });

    it('unknown project -> 404', async () => {
      await uploadAs(
        'alice',
        { projectId: 'nope', title: 'X' },
        { name: 'a.pdf', body: PDF },
      ).expect(404);
    });

    it('project B gets its own document (for isolation checks)', async () => {
      const res = await uploadAs(
        'erin',
        { projectId: projectB, title: 'B doc' },
        { name: 'b.pdf', body: PDF },
      ).expect(201);
      state.docB = res.body.id;
    });
  });

  // ==================================================================
  describe('25 MB limit', () => {
    it('exactly 25 MB is accepted', async () => {
      const res = await uploadAs(
        'alice',
        { projectId: projectA, title: 'Max size' },
        { name: 'big.pdf', body: Buffer.alloc(MAX_FILE_SIZE_BYTES, 1) },
      ).expect(201);
      expect(res.body.fileSize).toBe(MAX_FILE_SIZE_BYTES);
      await http()
        .delete(`${API}/documents/${res.body.id}`)
        .set(as('alice'))
        .expect(200);
    });

    it('25 MB + 1 byte is rejected with 413 and nothing is stored', async () => {
      storage.calls.length = 0;
      const res = await uploadAs(
        'alice',
        { projectId: projectA, title: 'Too big' },
        { name: 'big.pdf', body: Buffer.alloc(MAX_FILE_SIZE_BYTES + 1, 1) },
      );
      expect(res.status).toBe(413);
      expect(res.body.code).toBe('FILE_TOO_LARGE');
      expect(storage.pathsOf('upload')).toEqual([]);
    });
  });

  // ==================================================================
  describe('Read access', () => {
    it('student lists only their own project documents', async () => {
      const res = await http()
        .get(`${API}/documents`)
        .set(as('alice'))
        .expect(200);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body.every((d: any) => d.projectId === projectA)).toBe(true);
      expect(res.body.map((d: any) => d.id)).not.toContain(state.docB);
      const doc = res.body.find((d: any) => d.id === state.docId);
      expect(doc).toMatchObject({
        fileName: ARABIC_NAME,
        currentVersion: 1,
        versionCount: 1,
      });
    });

    it('student cannot list or read another project', async () => {
      const list = await http()
        .get(`${API}/documents?projectId=${projectB}`)
        .set(as('alice'))
        .expect(403);
      expect(list.body.code).toBe('PROJECT_ACCESS_DENIED');
      await http()
        .get(`${API}/documents/${state.docB}`)
        .set(as('alice'))
        .expect(403);
      await http()
        .get(`${API}/documents/${state.docB}/versions`)
        .set(as('alice'))
        .expect(403);
    });

    it('supervisor reads the supervised project', async () => {
      const list = await http()
        .get(`${API}/documents`)
        .set(as('supA'))
        .expect(200);
      expect(list.body.every((d: any) => d.projectId === projectA)).toBe(true);
      await http()
        .get(`${API}/documents?projectId=${projectA}`)
        .set(as('supA'))
        .expect(200);
      await http()
        .get(`${API}/documents/${state.docId}`)
        .set(as('supA'))
        .expect(200);
      await http()
        .get(`${API}/documents/${state.docId}/versions`)
        .set(as('supA'))
        .expect(200);
    });

    it('unrelated supervisor sees nothing and gets 403', async () => {
      const list = await http()
        .get(`${API}/documents`)
        .set(as('supB'))
        .expect(200);
      expect(list.body).toEqual([]);
      await http()
        .get(`${API}/documents?projectId=${projectA}`)
        .set(as('supB'))
        .expect(403);
      await http()
        .get(`${API}/documents/${state.docId}`)
        .set(as('supB'))
        .expect(403);
      await http()
        .get(`${API}/documents/${state.docId}/versions`)
        .set(as('supB'))
        .expect(403);
    });

    it('get one returns a signed URL and a download URL with the original name', async () => {
      storage.calls.length = 0;
      const res = await http()
        .get(`${API}/documents/${state.docId}`)
        .set(as('alice'))
        .expect(200);
      expect(storage.pathsOf('sign')).toEqual([state.v1Path]);
      expect(res.body.signedUrl).toContain('token=');
      expect(res.body.downloadUrl).toBe(
        `${res.body.signedUrl}&download=${encodeURIComponent(ARABIC_NAME)}`,
      );
      const ttl = new Date(res.body.signedUrlExpiresAt).getTime() - Date.now();
      expect(ttl).toBeGreaterThan(55 * 60 * 1000);
      expect(ttl).toBeLessThanOrEqual(60 * 60 * 1000);
      expect(JSON.stringify(res.body)).not.toMatch(
        /sb_secret_|SUPABASE_SECRET_KEY/,
      );
    });

    it('unknown document -> 404 DOCUMENT_NOT_FOUND', async () => {
      const res = await http()
        .get(`${API}/documents/nope`)
        .set(as('alice'))
        .expect(404);
      expect(res.body.code).toBe('DOCUMENT_NOT_FOUND');
    });

    it('storage outage while signing -> 503 STORAGE_ERROR, nothing deleted', async () => {
      storage.failNext('sign');
      storage.calls.length = 0;
      const res = await http()
        .get(`${API}/documents/${state.docId}`)
        .set(as('alice'))
        .expect(503);
      expect(res.body.code).toBe('STORAGE_ERROR');
      expect(storage.pathsOf('remove')).toEqual([]);
    });
  });

  // ==================================================================
  describe('Update metadata', () => {
    it('student updates title, description, category', async () => {
      const res = await http()
        .patch(`${API}/documents/${state.docId}`)
        .set(as('bob'))
        .send({
          title: 'Chapter 3: Design',
          description: null,
          category: 'DOCUMENTATION',
        })
        .expect(200);
      expect(res.body).toMatchObject({
        title: 'Chapter 3: Design',
        description: null,
        category: 'DOCUMENTATION',
      });
      expect(res.body.fileUrl).toBe(state.v1Path); // file unchanged
    });

    it('supervisor, other-project student -> 403; invalid body -> 400', async () => {
      await http()
        .patch(`${API}/documents/${state.docId}`)
        .set(as('supA'))
        .send({ title: 'Nope' })
        .expect(403);
      const e = await http()
        .patch(`${API}/documents/${state.docId}`)
        .set(as('erin'))
        .send({ title: 'Nope' })
        .expect(403);
      expect(e.body.code).toBe('PROJECT_ACCESS_DENIED');
      await http()
        .patch(`${API}/documents/${state.docId}`)
        .set(as('alice'))
        .send({ title: '' })
        .expect(400);
      await http()
        .patch(`${API}/documents/${state.docId}`)
        .set(as('alice'))
        .send({ fileUrl: 'x/y/z' })
        .expect(400);
      await http()
        .patch(`${API}/documents/${state.docId}`)
        .set(as('alice'))
        .send({ category: 'NOPE' })
        .expect(400);
    });
  });

  // ==================================================================
  describe('Versions', () => {
    it('version 2 increments, becomes current, and keeps version 1', async () => {
      storage.calls.length = 0;
      const body = Buffer.from('%PDF-1.4 version two, longer content');
      const res = await versionAs('alice', state.docId, {
        name: 'report-v2.docx',
        body,
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }).expect(201);

      expect(res.body).toMatchObject({
        currentVersion: 2,
        versionCount: 2,
        fileName: 'report-v2.docx',
        fileSize: body.length,
      });
      state.v2Path = storage.pathsOf('upload')[0];
      expect(state.v2Path).not.toBe(state.v1Path);
      expect(state.v2Path.split('/').slice(0, 2)).toEqual(
        state.v1Path.split('/').slice(0, 2),
      ); // same document folder

      const doc = db.document.rows.find((d) => d.id === state.docId)!;
      expect(doc).toMatchObject({
        fileUrl: state.v2Path,
        fileType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        fileSize: body.length,
      });
      const versions = db.documentVersion.rows
        .filter((v) => v.documentId === state.docId)
        .sort((a, b) => a.version - b.version);
      expect(versions.map((v) => [v.version, v.fileUrl])).toEqual([
        [1, state.v1Path],
        [2, state.v2Path],
      ]);
      expect(storage.objects.has(state.v1Path)).toBe(true); // old file preserved
    });

    it('version history: newest first, one batch signing request, signed + download URLs', async () => {
      storage.calls.length = 0;
      const res = await http()
        .get(`${API}/documents/${state.docId}/versions`)
        .set(as('supA'))
        .expect(200);
      expect(res.body.map((v: any) => v.version)).toEqual([2, 1]);
      expect(res.body.map((v: any) => v.fileName)).toEqual([
        'report-v2.docx',
        ARABIC_NAME,
      ]);
      expect(storage.calls).toEqual([
        { op: 'sign', paths: [state.v2Path, state.v1Path] },
      ]);
      for (const v of res.body) {
        expect(v.signedUrl).toContain('token=');
        expect(v.downloadUrl).toContain('&download=');
      }
    });

    it('concurrent version uploads get distinct consecutive numbers', async () => {
      await Promise.all([
        versionAs('alice', state.docId, { name: 'c1.pdf', body: PDF }).expect(
          201,
        ),
        versionAs('bob', state.docId, { name: 'c2.pdf', body: PDF }).expect(
          201,
        ),
      ]);
      const numbers = db.documentVersion.rows
        .filter((v) => v.documentId === state.docId)
        .map((v) => v.version)
        .sort();
      expect(numbers).toEqual([1, 2, 3, 4]);
    });

    it('missing file / blocked type / supervisor / other project / unknown document', async () => {
      expect(
        (await versionAs('alice', state.docId).expect(400)).body.code,
      ).toBe('FILE_REQUIRED');
      expect(
        (
          await versionAs('alice', state.docId, {
            name: 'x.exe',
            body: PDF,
          }).expect(400)
        ).body.code,
      ).toBe('FILE_TYPE_NOT_ALLOWED');
      await versionAs('supA', state.docId, { name: 'x.pdf', body: PDF }).expect(
        403,
      );
      await versionAs('erin', state.docId, { name: 'x.pdf', body: PDF }).expect(
        403,
      );
      expect(
        (
          await versionAs('alice', 'nope', { name: 'x.pdf', body: PDF }).expect(
            404,
          )
        ).body.code,
      ).toBe('DOCUMENT_NOT_FOUND');
    });
  });

  // ==================================================================
  describe('Storage / database consistency', () => {
    it('DB failure on upload -> the uploaded object is removed', async () => {
      storage.calls.length = 0;
      const spy = jest
        .spyOn(db.document, 'create')
        .mockRejectedValueOnce(new Error('db down'));
      await uploadAs(
        'alice',
        { projectId: projectA, title: 'Will fail' },
        { name: 'f.pdf', body: PDF },
      ).expect(500);
      spy.mockRestore();
      const [path] = storage.pathsOf('upload');
      expect(storage.pathsOf('remove')).toEqual([path]);
      expect(storage.objects.has(path)).toBe(false);
      expect(db.document.rows.some((d) => d.title === 'Will fail')).toBe(false);
    });

    it('DB failure on a new version -> object removed, current version unchanged', async () => {
      const before = { ...db.document.rows.find((d) => d.id === state.docId)! };
      const versionsBefore = db.documentVersion.rows.filter(
        (v) => v.documentId === state.docId,
      ).length;
      storage.calls.length = 0;
      const spy = jest
        .spyOn(db.documentVersion, 'create')
        .mockRejectedValueOnce(new Error('db down'));
      await versionAs('alice', state.docId, {
        name: 'f.pdf',
        body: PDF,
      }).expect(500);
      spy.mockRestore();

      const [path] = storage.pathsOf('upload');
      expect(storage.pathsOf('remove')).toEqual([path]);
      expect(storage.objects.has(path)).toBe(false);
      // the transaction rolled back: the document still points at its previous file
      const after = db.document.rows.find((d) => d.id === state.docId)!;
      expect(after).toMatchObject({
        fileUrl: before.fileUrl,
        fileSize: before.fileSize,
        fileType: before.fileType,
      });
      expect(
        db.documentVersion.rows.filter((v) => v.documentId === state.docId),
      ).toHaveLength(versionsBefore);
    });

    it('Storage failure on upload -> 503, no database rows', async () => {
      const count = db.document.rows.length;
      storage.failNext('upload');
      const res = await uploadAs(
        'alice',
        { projectId: projectA, title: 'Storage down' },
        { name: 'f.pdf', body: PDF },
      ).expect(503);
      expect(res.body.code).toBe('STORAGE_ERROR');
      expect(db.document.rows.length).toBe(count);
    });

    it('cleanup failure after a DB error keeps the original DB error', async () => {
      storage.failNext('remove', 2); // removal and its retry both fail
      const spy = jest
        .spyOn(db.document, 'create')
        .mockRejectedValueOnce(new Error('db down'));
      await uploadAs(
        'alice',
        { projectId: projectA, title: 'Double failure' },
        { name: 'f.pdf', body: PDF },
      ).expect(500);
      spy.mockRestore();
    });
  });

  // ==================================================================
  describe('Delete', () => {
    it('supervisor and other-project student cannot delete', async () => {
      await http()
        .delete(`${API}/documents/${state.docId}`)
        .set(as('supA'))
        .expect(403);
      await http()
        .delete(`${API}/documents/${state.docId}`)
        .set(as('erin'))
        .expect(403);
    });

    it('removes every unique storage path in one request, then the DB rows; nothing else', async () => {
      const ownPaths = db.documentVersion.rows
        .filter((v) => v.documentId === state.docId)
        .map((v) => v.fileUrl);
      expect(ownPaths).toHaveLength(4);
      const otherObjects = [...storage.objects.keys()].filter(
        (p) => !ownPaths.includes(p),
      );
      expect(otherObjects.length).toBeGreaterThan(0);

      storage.calls.length = 0;
      await http()
        .delete(`${API}/documents/${state.docId}`)
        .set(as('bob'))
        .expect(200)
        .expect({
          message: 'Document deleted',
          storage: { status: 'REMOVED', pendingObjects: 0 },
        });

      const removed = storage.pathsOf('remove');
      expect(storage.calls.filter((c) => c.op === 'remove')).toHaveLength(1);
      expect([...removed].sort()).toEqual([...ownPaths].sort());
      expect(new Set(removed).size).toBe(removed.length); // no duplicates
      expect(db.document.rows.some((d) => d.id === state.docId)).toBe(false);
      expect(
        db.documentVersion.rows.some((v) => v.documentId === state.docId),
      ).toBe(false);
      for (const p of otherObjects) expect(storage.objects.has(p)).toBe(true); // unrelated files kept
      await http()
        .get(`${API}/documents/${state.docId}`)
        .set(as('alice'))
        .expect(404);
    });

    it('storage outage during delete: DB is deleted, one retry, request succeeds', async () => {
      const up = await uploadAs(
        'alice',
        { projectId: projectA, title: 'Retry' },
        { name: 'r.pdf', body: PDF },
      ).expect(201);
      const path = db.document.rows.find((d) => d.id === up.body.id)!.fileUrl;
      storage.failNext('remove'); // first attempt fails, retry succeeds
      await http()
        .delete(`${API}/documents/${up.body.id}`)
        .set(as('alice'))
        .expect(200);
      expect(storage.objects.has(path)).toBe(false);
      expect(db.document.rows.some((d) => d.id === up.body.id)).toBe(false);
    });

    it('never deletes a stored path outside the project folder (corrupted DB value)', async () => {
      const up = await uploadAs(
        'alice',
        { projectId: projectA, title: 'Scoped' },
        { name: 's.pdf', body: PDF },
      ).expect(201);
      const foreign = db.document.rows.find(
        (d) => d.id === state.docB,
      )!.fileUrl;
      await db.documentVersion.create({
        data: { documentId: up.body.id, fileUrl: foreign, version: 2 },
      });
      storage.calls.length = 0;
      await http()
        .delete(`${API}/documents/${up.body.id}`)
        .set(as('alice'))
        .expect(200);
      expect(storage.pathsOf('remove')).not.toContain(foreign);
      expect(storage.objects.has(foreign)).toBe(true);
    });

    it('documents uploaded by the first P07 draft (old path format) still work', async () => {
      const legacyPath = `${projectA}/11111111-2222-3333-4444-555555555555/v1-1760000000000-old-report.pdf`;
      storage.objects.set(legacyPath, {
        size: 3,
        contentType: 'application/pdf',
        body: Buffer.from('old'),
      });
      const doc = await db.document.create({
        data: {
          title: 'Legacy',
          projectId: projectA,
          uploadedById: users.alice.id,
          fileUrl: legacyPath,
          fileType: 'application/pdf',
          fileSize: 3,
        },
      });
      await db.documentVersion.create({
        data: { documentId: doc!.id, fileUrl: legacyPath, version: 1 },
      });

      const one = await http()
        .get(`${API}/documents/${doc!.id}`)
        .set(as('alice'))
        .expect(200);
      expect(one.body.fileName).toBe('old-report.pdf');
      const v2 = await versionAs('alice', doc!.id, {
        name: 'new.pdf',
        body: PDF,
      }).expect(201);
      expect(v2.body.currentVersion).toBe(2);
      await http()
        .delete(`${API}/documents/${doc!.id}`)
        .set(as('alice'))
        .expect(200);
      expect(storage.objects.has(legacyPath)).toBe(false);
    });
  });
});
