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
import { UsersModule } from '@modules/users/users.module';
import { ProjectsModule } from '@modules/projects/projects.module';
import { TeamsModule } from '@modules/teams/teams.module';
import { TasksModule } from '@modules/tasks/tasks.module';
import { DocumentsModule } from '@modules/documents/documents.module';
import { SupabaseStorageService } from '@modules/documents/supabase-storage.service';
import { AVATAR_MAX_LENGTH } from '@modules/users/dto/account.dto';

/**
 * Task attachments (project files linked to a task) and the profile photo (PATCH /users/me avatar).
 * Real controllers, services, guards and validation; Prisma in memory, storage faked.
 */
describe('Task attachments and profile photo (integration)', () => {
  let app: INestApplication;
  let db: InMemoryPrisma;
  let jwt: JwtService;
  const API = '/api/v1';
  const users: Record<string, { id: string; token: string }> = {};
  const as = (key: string) => ({ Authorization: `Bearer ${users[key].token}` });
  const http = () => request(app.getHttpServer());
  const PDF = Buffer.from('%PDF-1.4 fake test document');
  const PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  let projectA = '';
  let projectB = '';
  let taskForBob = '';
  let docA = '';
  let docB = '';

  async function seedUser(key: string, role: string) {
    const u = await db.user.create({
      data: {
        email: `${key}@test.local`,
        password: 'unused',
        firstName: key,
        role,
        studentNumber: role === 'STUDENT' ? `SN-${key.toUpperCase()}` : null,
        universityId: 'uni-1',
      },
    });
    users[key] = {
      id: u!.id,
      token: jwt.sign({ sub: u!.id, email: u!.email, role }),
    };
  }
  const upload = async (who: string, projectId: string, title: string) =>
    (
      await http()
        .post(`${API}/documents/upload`)
        .set(as(who))
        .field('projectId', projectId)
        .field('title', title)
        .attach('file', PDF, {
          filename: `${title}.pdf`,
          contentType: 'application/pdf',
        })
        .expect(201)
    ).body.id as string;

  beforeAll(async () => {
    db = createInMemoryPrisma();
    const moduleRef = await Test.createTestingModule({
      imports: [
        testConfigModule(),
        AuthModule,
        UsersModule,
        TeamsModule,
        ProjectsModule,
        TasksModule,
        DocumentsModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(db)
      .overrideProvider(SupabaseStorageService)
      .useValue(new FakeStorageService())
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    jwt = app.get(JwtService);

    for (const s of ['alice', 'bob', 'carl', 'erin'])
      await seedUser(s, 'STUDENT');
    // Project A: alice (leader), bob and carl (members). Project B: erin.
    const a = await http()
      .post(`${API}/projects`)
      .set(as('alice'))
      .send({ name: 'Project A' })
      .expect(201);
    projectA = a.body.project.id;
    for (const who of ['bob', 'carl']) {
      await http()
        .post(`${API}/teams/join`)
        .set(as(who))
        .send({ code: a.body.invitation.code })
        .expect(200);
    }
    const b = await http()
      .post(`${API}/projects`)
      .set(as('erin'))
      .send({ name: 'Project B' })
      .expect(201);
    projectB = b.body.project.id;
    taskForBob = (
      await http()
        .post(`${API}/tasks`)
        .set(as('alice'))
        .send({
          projectId: projectA,
          title: 'Write chapter 3',
          assignedStudentId: users.bob.id,
        })
        .expect(201)
    ).body.id;
    docA = await upload('carl', projectA, 'Plan');
    docB = await upload('erin', projectB, 'Other');
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('task attachments', () => {
    const path = () => `${API}/tasks/${taskForBob}/attachments`;

    it('starts empty and requires a token', async () => {
      await http().get(path()).expect(401);
      const r = await http().get(path()).set(as('carl')).expect(200);
      expect(r.body).toEqual([]);
    });

    it('the assignee links a file of the project; every team member sees it', async () => {
      const r = await http()
        .post(path())
        .set(as('bob'))
        .send({ documentId: docA })
        .expect(201);
      expect(r.body).toEqual([
        expect.objectContaining({
          taskId: taskForBob,
          documentId: docA,
          title: 'Plan',
          fileName: 'Plan.pdf',
        }),
      ]);
      const seen = await http().get(path()).set(as('carl')).expect(200);
      expect(seen.body).toHaveLength(1);
      // the linked file opens through the documents API (signed URL)
      const doc = await http()
        .get(`${API}/documents/${seen.body[0].documentId}`)
        .set(as('carl'))
        .expect(200);
      expect(doc.body.signedUrl).toBeTruthy();
    });

    it('refuses duplicates, files of another project, and other members', async () => {
      const dup = await http()
        .post(path())
        .set(as('alice'))
        .send({ documentId: docA })
        .expect(409);
      expect(dup.body.code).toBe('ATTACHMENT_EXISTS');
      const other = await http()
        .post(path())
        .set(as('alice'))
        .send({ documentId: docB })
        .expect(400);
      expect(other.body.code).toBe('ATTACHMENT_DOCUMENT_INVALID');
      // a student of another team cannot attach (any student of this team can)
      await http()
        .post(path())
        .set(as('erin'))
        .send({ documentId: docA })
        .expect(403);
      await http().get(path()).set(as('erin')).expect(403);
    });

    it('a student of the team removes it; the file stays in the project', async () => {
      const list = await http().get(path()).set(as('alice')).expect(200);
      await http()
        .delete(`${path()}/${list.body[0].id}`)
        .set(as('erin'))
        .expect(403);
      const r = await http()
        .delete(`${path()}/${list.body[0].id}`)
        .set(as('alice'))
        .expect(200);
      expect(r.body).toEqual([]);
      await http().get(`${API}/documents/${docA}`).set(as('alice')).expect(200);
      await http()
        .delete(`${path()}/${list.body[0].id}`)
        .set(as('alice'))
        .expect(404);
    });

    it('a deleted project file disappears from the task', async () => {
      await http()
        .post(path())
        .set(as('alice'))
        .send({ documentId: docA })
        .expect(201);
      await http()
        .delete(`${API}/documents/${docA}`)
        .set(as('carl'))
        .expect(200);
      const r = await http().get(path()).set(as('bob')).expect(200);
      expect(r.body).toEqual([]);
    });

    it('is documented in Swagger', () => {
      const paths = createSwaggerDocument(app).paths;
      expect(Object.keys(paths)).toEqual(
        expect.arrayContaining([
          `${API}/tasks/{taskId}/attachments`,
          `${API}/tasks/{taskId}/attachments/{attachmentId}`,
        ]),
      );
    });
  });

  describe('profile photo', () => {
    it('saves a small image and returns it with the account', async () => {
      const r = await http()
        .patch(`${API}/users/me`)
        .set(as('bob'))
        .send({ avatar: PNG })
        .expect(200);
      expect(r.body.avatar).toBe(PNG);
      const me = await http().get(`${API}/auth/me`).set(as('bob')).expect(200);
      expect(me.body.avatar).toBe(PNG);
    });

    it('team members see the photo in the project workspace', async () => {
      const w = await http()
        .get(`${API}/projects/${projectA}`)
        .set(as('alice'))
        .expect(200);
      const bob = w.body.team.members.find(
        (m: { userId: string }) => m.userId === users.bob.id,
      );
      expect(bob.user.avatar).toBe(PNG);
    });

    it('refuses other formats and images that are too large', async () => {
      await http()
        .patch(`${API}/users/me`)
        .set(as('bob'))
        .send({ avatar: 'https://example.com/me.png' })
        .expect(400);
      await http()
        .patch(`${API}/users/me`)
        .set(as('bob'))
        .send({ avatar: 'data:image/svg+xml;base64,PHN2Zz4=' })
        .expect(400);
      const big = `data:image/jpeg;base64,${'A'.repeat(AVATAR_MAX_LENGTH)}`;
      await http()
        .patch(`${API}/users/me`)
        .set(as('bob'))
        .send({ avatar: big })
        .expect(400);
    });

    it('null removes the photo', async () => {
      const r = await http()
        .patch(`${API}/users/me`)
        .set(as('bob'))
        .send({ avatar: null })
        .expect(200);
      expect(r.body.avatar).toBeNull();
    });
  });
});
