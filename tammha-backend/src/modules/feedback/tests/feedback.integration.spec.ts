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
import { FeedbackModule } from '@modules/feedback/feedback.module';
import { SupabaseStorageService } from '@modules/documents/supabase-storage.service';

/**
 * HTTP integration tests for P08: supervisor feedback, submission status,
 * task feedback (no grading) and the notification records they create.
 * Real: controllers, guards, ValidationPipe, services, workspace access, error filter.
 * Replaced: Prisma (in-memory, with transaction rollback) and Supabase Storage.
 */
describe('Feedback & submission status (integration)', () => {
  let app: INestApplication;
  let db: InMemoryPrisma;
  let jwt: JwtService;

  const API = '/api/v1';
  const users: Record<string, { id: string; token: string }> = {};
  const as = (key: string) => ({ Authorization: `Bearer ${users[key].token}` });
  const http = () => request(app.getHttpServer());
  const PDF = Buffer.from('%PDF-1.4 fake test document');

  let projectA = '';
  let projectB = '';
  let docA = '';
  let docB = '';

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

  async function assignSupervisor(
    student: string,
    projectId: string,
    sup: string,
  ) {
    const req = await http()
      .post(`${API}/projects/${projectId}/supervision-requests`)
      .set(as(student))
      .send({ supervisorEmail: `${sup}@test.local` })
      .expect(201);
    await http()
      .post(`${API}/supervision-requests/${req.body.id}/accept`)
      .set(as(sup))
      .send({})
      .expect(200);
  }

  const upload = (who: string, projectId: string, title: string) =>
    http()
      .post(`${API}/documents/upload`)
      .set(as(who))
      .field('projectId', projectId)
      .field('title', title)
      // a formal submission: sent to the supervisor for review
      .field('submitForReview', 'true')
      .attach('file', PDF, {
        filename: 'r.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);

  const give = (who: string, body: Record<string, unknown>) =>
    http().post(`${API}/feedback`).set(as(who)).send(body);

  const setStatus = (who: string, id: string, body: Record<string, unknown>) =>
    http()
      .patch(`${API}/documents/${id}/submission-status`)
      .set(as(who))
      .send(body);

  const notificationsOf = (key: string) =>
    db.notification.rows.filter((n: any) => n.userId === users[key].id);

  beforeAll(async () => {
    db = createInMemoryPrisma();
    const moduleRef = await Test.createTestingModule({
      imports: [
        testConfigModule(),
        AuthModule,
        TeamsModule,
        ProjectsModule,
        DocumentsModule,
        FeedbackModule,
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

    for (const s of ['alice', 'bob', 'erin']) await seedUser(s, 'STUDENT');
    for (const s of ['supA', 'supB']) await seedUser(s, 'SUPERVISOR');
    await seedUser('admin', 'ADMIN');

    // Project A: alice + bob, supervised by supA. Project B: erin, supervised by supB.
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
    await assignSupervisor('alice', projectA, 'supA');
    await assignSupervisor('erin', projectB, 'supB');

    docA = (await upload('bob', projectA, 'Chapter 1')).body.id;
    docB = (await upload('erin', projectB, 'Proposal')).body.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  // ==================================================================
  describe('JWT, roles and Swagger', () => {
    it.each([
      ['post', '/feedback'],
      ['get', '/feedback'],
      ['get', '/feedback/x'],
      ['patch', '/feedback/x'],
      ['patch', '/documents/x/submission-status'],
    ])('%s %s -> 401 without token', async (method, path) => {
      await (http() as any)[method](`${API}${path}`).expect(401);
    });

    it('students cannot give feedback or change a submission status', async () => {
      await give('alice', { projectId: projectA, comment: 'x' }).expect(403);
      await setStatus('alice', docA, { status: 'APPROVED' }).expect(403);
    });

    it('ADMIN has no access to feedback', async () => {
      await give('admin', { projectId: projectA, comment: 'x' }).expect(403);
      await http().get(`${API}/feedback`).set(as('admin')).expect(403);
      await setStatus('admin', docA, { status: 'APPROVED' }).expect(403);
    });

    it('Swagger documents the new routes', () => {
      const paths = createSwaggerDocument(app).paths;
      expect(Object.keys(paths)).toEqual(
        expect.arrayContaining([
          `${API}/feedback`,
          `${API}/feedback/{id}`,
          `${API}/documents/{id}/submission-status`,
        ]),
      );
      expect(paths[`${API}/feedback`].post).toBeDefined();
      expect(paths[`${API}/feedback/{id}`].patch).toBeDefined();
    });
  });

  // ==================================================================
  describe('Submission notifications for supervisors', () => {
    it('upload notifies the project supervisor only', () => {
      // (P16: the supervision request itself is also a notification; not counted here)
      const forSupA = notificationsOf('supA').filter(
        (n: any) => n.type !== 'SUPERVISION_REQUESTED',
      );
      expect(forSupA).toHaveLength(1);
      expect(forSupA[0]).toMatchObject({
        type: 'DOCUMENT_SUBMITTED', // P11 (was PROJECT_UPDATE)
        dedupeKey: `document:${docA}:v1`,
        title: 'New submission',
        data: expect.objectContaining({
          kind: 'document_submitted',
          projectId: projectA,
          documentId: docA,
          version: 1,
        }),
      });
      expect(
        notificationsOf('supB')
          .filter((n: any) => n.type === 'DOCUMENT_SUBMITTED')
          .map((n: any) => n.data.documentId),
      ).toEqual([docB]);
      // students only learned that the supervisor accepted (P16), nothing about the upload
      expect(notificationsOf('alice').map((n: any) => n.type)).toEqual([
        'SUPERVISION_RESPONDED',
      ]);
    });

    it('a document sent for review starts as SUBMITTED', async () => {
      const res = await http()
        .get(`${API}/documents/${docA}`)
        .set(as('supA'))
        .expect(200);
      expect(res.body.reviewStatus).toBe('SUBMITTED');
      expect(res.body.reviewStatusUpdatedAt).toBeNull();
    });
  });

  // ==================================================================
  describe('Create feedback', () => {
    let projectFeedback = '';

    it('supervisor gives project feedback; the team students are notified', async () => {
      const before = db.notification.rows.length;
      const res = await give('supA', {
        projectId: projectA,
        comment: '  Good start on the scope  ',
        category: 'TECHNICAL_SKILLS',
      }).expect(201);
      projectFeedback = res.body.id;
      expect(res.body).toMatchObject({
        projectId: projectA,
        documentId: null,
        documentVersion: null,
        supervisorId: users.supA.id,
        comment: 'Good start on the scope',
        category: 'TECHNICAL_SKILLS',
        status: null,
        taskId: null,
        edited: false,
      });
      expect(res.body.supervisor).toMatchObject({ id: users.supA.id });
      expect(res.body.supervisor.password).toBeUndefined();

      const created = db.notification.rows.slice(before);
      expect(created.map((n: any) => n.userId).sort()).toEqual(
        [users.alice.id, users.bob.id].sort(),
      );
      expect(created[0]).toMatchObject({
        type: 'FEEDBACK_RECEIVED',
        title: 'New feedback',
        message: 'Your supervisor left feedback on your project.',
        data: expect.objectContaining({
          kind: 'feedback_created',
          feedbackId: projectFeedback,
          projectId: projectA,
        }),
      });
    });

    it('document feedback: project is taken from the document, version recorded', async () => {
      const res = await give('supA', {
        documentId: docA,
        comment: 'Fix the references',
      }).expect(201);
      expect(res.body).toMatchObject({
        projectId: projectA,
        documentId: docA,
        documentVersion: 1,
        document: { id: docA, title: 'Chapter 1' },
      });
      const row = db.feedback.rows.find((f: any) => f.id === res.body.id)!;
      expect(row.receivedById).toBe(users.bob.id); // the uploader
    });

    it('an unrelated supervisor gets 403 (project and document)', async () => {
      const p = await give('supB', {
        projectId: projectA,
        comment: 'x',
      }).expect(403);
      expect(p.body.code).toBe('PROJECT_ACCESS_DENIED');
      await give('supB', { documentId: docA, comment: 'x' }).expect(403);
      await setStatus('supB', docA, { status: 'APPROVED' }).expect(403);
    });

    it.each([
      ['no target', { comment: 'x' }, 'FEEDBACK_TARGET_REQUIRED'],
      ['nothing to say', { projectId: 'P' }, 'FEEDBACK_EMPTY'],
      [
        'blank comment only',
        { projectId: 'P', comment: '   ' },
        'FEEDBACK_EMPTY',
      ],
      [
        'status without a document',
        { projectId: 'P', status: 'APPROVED' },
        'STATUS_REQUIRES_DOCUMENT',
      ],
      [
        'document of another project',
        { projectId: 'B', documentId: 'DA', comment: 'x' },
        'DOCUMENT_PROJECT_MISMATCH',
      ],
    ])('400 %s', async (_name, body: any, code) => {
      const resolved = { ...body };
      if (resolved.projectId === 'P') resolved.projectId = projectA;
      if (resolved.projectId === 'B') resolved.projectId = projectB;
      if (resolved.documentId === 'DA') resolved.documentId = docA;
      const count = db.feedback.rows.length;
      const res = await give('supA', resolved).expect(400);
      expect(res.body.code).toBe(code);
      expect(db.feedback.rows.length).toBe(count);
    });

    it.each([
      ['SUBMITTED is not a supervisor decision', { status: 'SUBMITTED' }],
      ['unknown status', { status: 'DONE' }],
      ['unknown field', { comment: 'x', grade: 'A' }],
      ['comment too long', { comment: 'x'.repeat(5001) }],
    ])('400 validation: %s', async (_name, body) => {
      await give('supA', { documentId: docA, ...body }).expect(400);
    });

    it('404 for an unknown document or project', async () => {
      const d = await give('supA', { documentId: 'nope', comment: 'x' }).expect(
        404,
      );
      expect(d.body.code).toBe('DOCUMENT_NOT_FOUND');
      await give('supA', { projectId: 'nope', comment: 'x' }).expect(404);
    });

    it('feedback can be read back by id (students and supervisor)', async () => {
      await http()
        .get(`${API}/feedback/${projectFeedback}`)
        .set(as('bob'))
        .expect(200);
      await http()
        .get(`${API}/feedback/${projectFeedback}`)
        .set(as('supA'))
        .expect(200);
      const other = await http()
        .get(`${API}/feedback/${projectFeedback}`)
        .set(as('erin'))
        .expect(403);
      expect(other.body.code).toBe('PROJECT_ACCESS_DENIED');
      await http()
        .get(`${API}/feedback/${projectFeedback}`)
        .set(as('supB'))
        .expect(403);
      const missing = await http()
        .get(`${API}/feedback/nope`)
        .set(as('supA'))
        .expect(404);
      expect(missing.body.code).toBe('FEEDBACK_NOT_FOUND');
    });
  });

  // ==================================================================
  describe('Submission status', () => {
    it('PATCH /documents/:id/submission-status records the decision and notifies students', async () => {
      const before = db.notification.rows.length;
      const res = await setStatus('supA', docA, {
        status: 'UNDER_REVIEW',
        comment: 'Reading it this week',
      }).expect(200);
      expect(res.body).toMatchObject({
        documentId: docA,
        status: 'UNDER_REVIEW',
        comment: 'Reading it this week',
      });

      const doc = await http()
        .get(`${API}/documents/${docA}`)
        .set(as('bob'))
        .expect(200);
      expect(doc.body.reviewStatus).toBe('UNDER_REVIEW');
      expect(doc.body.reviewStatusUpdatedAt).not.toBeNull();

      const created = db.notification.rows.slice(before);
      expect(created).toHaveLength(2);
      expect(created[0]).toMatchObject({
        title: 'Submission status updated',
        message: 'Your supervisor marked "Chapter 1" as under review.',
        data: expect.objectContaining({
          kind: 'submission_status',
          status: 'UNDER_REVIEW',
        }),
      });
    });

    it('the same decision twice -> 409, nothing stored, nobody notified', async () => {
      const f = db.feedback.rows.length;
      const n = db.notification.rows.length;
      const res = await setStatus('supA', docA, {
        status: 'UNDER_REVIEW',
      }).expect(409);
      expect(res.body.code).toBe('SUBMISSION_STATUS_UNCHANGED');
      expect(db.feedback.rows.length).toBe(f);
      expect(db.notification.rows.length).toBe(n);
    });

    it('POST /feedback with a status also updates the submission', async () => {
      await give('supA', {
        documentId: docA,
        status: 'CHANGES_REQUESTED',
        comment: 'Add the evaluation section',
      }).expect(201);
      const doc = await http()
        .get(`${API}/documents/${docA}`)
        .set(as('alice'))
        .expect(200);
      expect(doc.body.reviewStatus).toBe('CHANGES_REQUESTED');
    });

    it('a status alone (no comment) is valid feedback', async () => {
      await setStatus('supB', docB, { status: 'APPROVED' }).expect(200);
    });

    it('validation: status is required and must be a decision', async () => {
      await setStatus('supA', docA, {}).expect(400);
      await setStatus('supA', docA, { status: 'SUBMITTED' }).expect(400);
      const missing = await setStatus('supA', 'nope', {
        status: 'APPROVED',
      }).expect(404);
      expect(missing.body.code).toBe('DOCUMENT_NOT_FOUND');
    });

    it('history: GET /feedback?documentId= lists every decision, newest first', async () => {
      const res = await http()
        .get(`${API}/feedback?documentId=${docA}`)
        .set(as('bob'))
        .expect(200);
      expect(res.body.items.map((i: any) => i.status)).toEqual([
        'CHANGES_REQUESTED',
        'UNDER_REVIEW',
        null, // the earlier comment-only feedback
      ]);
      expect(res.body.meta).toMatchObject({ total: 3, page: 1 });

      const filtered = await http()
        .get(`${API}/feedback?projectId=${projectA}&status=UNDER_REVIEW`)
        .set(as('supA'))
        .expect(200);
      expect(filtered.body.items).toHaveLength(1);
    });

    it('a student uploading a new version resets the status to SUBMITTED and notifies the supervisor', async () => {
      const before = notificationsOf('supA').length;
      await http()
        .post(`${API}/documents/${docA}/versions`)
        .set(as('alice'))
        .attach('file', PDF, {
          filename: 'r2.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);

      const doc = await http()
        .get(`${API}/documents/${docA}`)
        .set(as('supA'))
        .expect(200);
      expect(doc.body.reviewStatus).toBe('SUBMITTED');
      const latest = notificationsOf('supA').slice(before);
      expect(latest).toHaveLength(1);
      expect(latest[0]).toMatchObject({
        title: 'Document resubmitted',
        data: expect.objectContaining({ documentId: docA, version: 2 }),
      });

      // the next decision is recorded against version 2
      const res = await setStatus('supA', docA, { status: 'APPROVED' }).expect(
        200,
      );
      expect(res.body.documentVersion).toBe(2);
    });

    it('GET /documents?status= filters by submission status', async () => {
      const approved = await http()
        .get(`${API}/documents?status=APPROVED`)
        .set(as('supA'))
        .expect(200);
      const items = approved.body.items ?? approved.body;
      expect(items.map((d: any) => d.id)).toEqual([docA]);
      const submitted = await http()
        .get(`${API}/documents?projectId=${projectA}&status=SUBMITTED`)
        .set(as('alice'))
        .expect(200);
      expect(submitted.body.items ?? submitted.body).toHaveLength(0);
      await http()
        .get(`${API}/documents?status=DONE`)
        .set(as('alice'))
        .expect(400);
    });
  });

  // ==================================================================
  describe('No grading', () => {
    it.each([
      ['score', { score: 17, maxScore: 20 }],
      ['rubric', { rubric: [{ criterion: 'A', score: 1, maxScore: 2 }] }],
      ['rating', { rating: 4 }],
      ['scoreVisibleToStudents', { scoreVisibleToStudents: true }],
    ])('grading fields are refused: %s', async (_name, extra) => {
      await give('supA', {
        projectId: projectA,
        comment: 'x',
        ...extra,
      }).expect(400);
    });

    it('feedback views carry no grading fields', async () => {
      const res = await give('supA', {
        projectId: projectA,
        comment: 'No grade here',
      }).expect(201);
      for (const key of [
        'score',
        'maxScore',
        'rubric',
        'rubricTotal',
        'scoreVisibleToStudents',
      ]) {
        expect(res.body).not.toHaveProperty(key);
      }
    });
  });

  // ==================================================================
  describe('Supervisor feedback on tasks', () => {
    let taskA = '';
    let taskB = '';
    const taskFeedback = (who: string, taskId: string, body: object) =>
      http().post(`${API}/tasks/${taskId}/feedback`).set(as(who)).send(body);

    beforeAll(async () => {
      taskA = (await db.task.create({
        data: {
          title: 'Write chapter 2',
          projectId: projectA,
          createdById: users.alice.id,
          assignedToId: users.bob.id,
          status: 'IN_PROGRESS',
        },
      }))!.id;
      taskB = (await db.task.create({
        data: {
          title: 'Survey',
          projectId: projectB,
          createdById: users.erin.id,
        },
      }))!.id;
    });

    it("the project's supervisor writes feedback on a task; the task is unchanged; students are notified", async () => {
      const before = JSON.stringify(
        db.task.rows.find((t: any) => t.id === taskA),
      );
      const notified = db.notification.rows.length;
      const res = await taskFeedback('supA', taskA, {
        comment: '  Add the interview results  ',
      }).expect(201);
      expect(res.body).toMatchObject({
        projectId: projectA,
        taskId: taskA,
        task: { id: taskA, title: 'Write chapter 2' },
        documentId: null,
        comment: 'Add the interview results',
        supervisorId: users.supA.id,
      });
      expect(
        db.feedback.rows.find((f: any) => f.id === res.body.id)!.receivedById,
      ).toBe(
        users.bob.id, // the assignee
      );
      expect(
        JSON.stringify(db.task.rows.find((t: any) => t.id === taskA)),
      ).toBe(before);
      const created = db.notification.rows.slice(notified);
      expect(created.map((n: any) => n.userId).sort()).toEqual(
        [users.alice.id, users.bob.id].sort(),
      );
      expect(created[0].message).toBe(
        'Your supervisor left feedback on the task "Write chapter 2".',
      );
    });

    it('students of the project read it (task route and /feedback?taskId=); outsiders cannot', async () => {
      for (const who of ['alice', 'bob', 'supA']) {
        const list = await http()
          .get(`${API}/tasks/${taskA}/feedback`)
          .set(as(who))
          .expect(200);
        expect(list.body.items).toHaveLength(1);
        expect(list.body.items[0].comment).toBe('Add the interview results');
      }
      const filtered = await http()
        .get(`${API}/feedback?taskId=${taskA}`)
        .set(as('alice'))
        .expect(200);
      expect(filtered.body.items).toHaveLength(1);
      await http()
        .get(`${API}/tasks/${taskA}/feedback`)
        .set(as('erin'))
        .expect(403);
      await http()
        .get(`${API}/tasks/${taskA}/feedback`)
        .set(as('supB'))
        .expect(403);
    });

    it('only the assigned supervisor can write it; students cannot', async () => {
      await taskFeedback('supB', taskA, { comment: 'x' }).expect(403);
      await taskFeedback('alice', taskA, { comment: 'x' }).expect(403);
      await taskFeedback('supB', taskB, { comment: 'ok' }).expect(201);
      const empty = await taskFeedback('supA', taskA, { comment: '  ' }).expect(
        400,
      );
      expect(empty.body.code).toBe('FEEDBACK_EMPTY');
      await taskFeedback('supA', 'nope', { comment: 'x' }).expect(404);
    });

    it('a task of another project or a document + task together is refused', async () => {
      const mismatch = await give('supA', {
        projectId: projectA,
        taskId: taskB,
        comment: 'x',
      }).expect(400);
      expect(mismatch.body.code).toBe('TASK_PROJECT_MISMATCH');
      const both = await give('supA', {
        documentId: docA,
        taskId: taskA,
        comment: 'x',
      }).expect(400);
      expect(both.body.code).toBe('FEEDBACK_TARGET_REQUIRED');
      // a review decision belongs to documents only
      const status = await give('supA', {
        taskId: taskA,
        status: 'APPROVED',
      }).expect(400);
      expect(status.body.code).toBe('STATUS_REQUIRES_DOCUMENT');
    });
  });

  // ==================================================================
  describe('Edit own feedback', () => {
    let mine = '';
    let decision = '';

    beforeAll(async () => {
      mine = (await give('supA', { projectId: projectA, comment: 'First' }))
        .body.id;
      decision = db.feedback.rows.find(
        (f: any) => f.documentId === docA && f.status === 'APPROVED',
      )!.id;
    });

    it('supervisor edits own comment -> edited, students notified', async () => {
      const before = db.notification.rows.length;
      const res = await http()
        .patch(`${API}/feedback/${mine}`)
        .set(as('supA'))
        .send({ comment: 'First (revised)', category: 'COMMUNICATION' })
        .expect(200);
      expect(res.body).toMatchObject({
        comment: 'First (revised)',
        category: 'COMMUNICATION',
        edited: true,
      });
      expect(db.notification.rows.length - before).toBe(2);
    });

    it('a change students cannot see does not notify them', async () => {
      const before = db.notification.rows.length;
      await http()
        .patch(`${API}/feedback/${mine}`)
        .set(as('supA'))
        .send({ category: 'GENERAL' })
        .expect(200);
      expect(db.notification.rows.length).toBe(before);
    });

    it('the recorded decision cannot be edited (record a new one instead)', async () => {
      await http()
        .patch(`${API}/feedback/${decision}`)
        .set(as('supA'))
        .send({ status: 'REJECTED' })
        .expect(400);
    });

    it('a decision may lose its comment; plain feedback may not become empty', async () => {
      await http()
        .patch(`${API}/feedback/${decision}`)
        .set(as('supA'))
        .send({ comment: null })
        .expect(200);
      const res = await http()
        .patch(`${API}/feedback/${mine}`)
        .set(as('supA'))
        .send({ comment: null })
        .expect(400);
      expect(res.body.code).toBe('FEEDBACK_EMPTY');
    });

    it('grades cannot be added when editing either', async () => {
      await http()
        .patch(`${API}/feedback/${mine}`)
        .set(as('supA'))
        .send({ score: 15, maxScore: 20 })
        .expect(400);
    });

    it('another supervisor cannot edit it; students cannot edit; unknown id -> 404', async () => {
      const other = await http()
        .patch(`${API}/feedback/${mine}`)
        .set(as('supB'))
        .send({ comment: 'hijack' })
        .expect(403);
      expect(other.body.code).toBe('FEEDBACK_NOT_OWNER');
      await http()
        .patch(`${API}/feedback/${mine}`)
        .set(as('alice'))
        .send({ comment: 'x' })
        .expect(403);
      const missing = await http()
        .patch(`${API}/feedback/nope`)
        .set(as('supA'))
        .send({ comment: 'x' })
        .expect(404);
      expect(missing.body.code).toBe('FEEDBACK_NOT_FOUND');
      expect(db.feedback.rows.find((f: any) => f.id === mine)!.comment).toBe(
        'First (revised)',
      );
    });
  });

  // ==================================================================
  describe('Read access', () => {
    it('students see only their own project feedback', async () => {
      const erin = await http()
        .get(`${API}/feedback`)
        .set(as('erin'))
        .expect(200);
      expect(erin.body.items.length).toBeGreaterThan(0);
      expect(erin.body.items.every((i: any) => i.projectId === projectB)).toBe(
        true,
      );

      const denied = await http()
        .get(`${API}/feedback?projectId=${projectA}`)
        .set(as('erin'))
        .expect(403);
      expect(denied.body.code).toBe('PROJECT_ACCESS_DENIED');
      await http()
        .get(`${API}/feedback?documentId=${docA}`)
        .set(as('erin'))
        .expect(403);
    });

    it('supervisors see only supervised projects', async () => {
      const supB = await http()
        .get(`${API}/feedback`)
        .set(as('supB'))
        .expect(200);
      expect(supB.body.items.every((i: any) => i.projectId === projectB)).toBe(
        true,
      );
      await http()
        .get(`${API}/feedback?projectId=${projectA}`)
        .set(as('supB'))
        .expect(403);
    });

    it('pagination works', async () => {
      const res = await http()
        .get(`${API}/feedback?projectId=${projectA}&limit=2&page=2`)
        .set(as('alice'))
        .expect(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.meta).toMatchObject({ page: 2, limit: 2 });
    });

    it("a documentId filter is checked against the document's own project", async () => {
      // supA supervises A but not B: asking for B's document is denied even with projectId=A
      const res = await http()
        .get(`${API}/feedback?projectId=${projectA}&documentId=${docB}`)
        .set(as('supA'))
        .expect(403);
      expect(res.body.code).toBe('PROJECT_ACCESS_DENIED');
    });
  });

  // ==================================================================
  describe('Document deletion keeps the feedback history', () => {
    it('feedback survives with documentId = null (ON DELETE SET NULL)', async () => {
      const ids = db.feedback.rows
        .filter((f: any) => f.documentId === docB)
        .map((f: any) => f.id);
      expect(ids.length).toBeGreaterThan(0);
      await http()
        .delete(`${API}/documents/${docB}`)
        .set(as('erin'))
        .expect(200);
      const res = await http()
        .get(`${API}/feedback/${ids[0]}`)
        .set(as('erin'))
        .expect(200);
      expect(res.body).toMatchObject({ documentId: null, projectId: projectB });
    });
  });
});
