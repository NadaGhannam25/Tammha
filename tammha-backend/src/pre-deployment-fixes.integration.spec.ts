import { readFileSync } from 'fs';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from './prisma/prisma.service';
import { configureApp } from './app.setup';
import {
  createInMemoryPrisma,
  InMemoryPrisma,
} from './testing/in-memory-prisma';
import { applyTestEnv } from './testing/test-env';
import { FakeStorageService } from './testing/fake-storage';
import { FakeAiTextProvider } from './testing/fake-ai-provider';
import { FakeEmailSender } from './testing/fake-email-sender';
import { SupabaseStorageService } from '@modules/documents/supabase-storage.service';
import { AI_TEXT_PROVIDER } from '@/integrations/ai/ai.provider';
import { EMAIL_SENDER } from '@/integrations/email/email.sender';
import { ProjectHandbookService } from '@modules/ai-support/handbook/project-handbook.service';
import { verificationCodeIn } from '@/testing/verification-code';

/**
 * Pre-deployment fixes (Nov 2026), on the real AppModule with e-mail verification ON:
 *  - academic supervisors register themselves with a university e-mail and verify it;
 *    they are offered to students only after verifying, and see only granted projects
 *  - project setup completes WITHOUT an academic supervisor (invited later)
 *  - stages keep their order; the first one becomes the current stage (IN_PROGRESS)
 *  - the team leader can assign tasks to themself
 *  - a regular upload is UPLOADED (no review); review only when asked for
 */
const API = '/api/v1';
const HANDBOOK_PDF = readFileSync(
  join(__dirname, 'testing/fixtures/handbook-sample.pdf'),
);
const DOC_PDF = Buffer.from('%PDF-1.4 fake test document');
const PASSWORD = 'Password123';
const DAY = 24 * 60 * 60 * 1000;
const day = (n: number) =>
  new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

describe('Pre-deployment fixes (AppModule integration)', () => {
  let app: INestApplication;
  let db: InMemoryPrisma;
  let handbooks: ProjectHandbookService;
  const mail = new FakeEmailSender();
  let uni = '';
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const http = () => request(app.getHttpServer());
  const as = (k: string) => ({ Authorization: `Bearer ${tokens[k]}` });
  /** P17: the latest verification code e-mailed to this address */
  const codeFor = (to: string) =>
    [...mail.sent]
      .reverse()
      .map((m) => (m.to === to ? verificationCodeIn(m.text) : null))
      .find((c) => !!c) ?? null;

  async function signUp(
    key: string,
    role: 'STUDENT' | 'SUPERVISOR',
    verify = true,
  ) {
    const email = `${key}@uni.edu.sa`;
    const res = await http()
      .post(`${API}/auth/register`)
      .send({
        email,
        password: PASSWORD,
        firstName: key,
        lastName: 'Tester',
        role,
        universityId: uni,
        ...(role === 'STUDENT' && { studentNumber: `S-${key}` }),
      })
      .expect(201);
    ids[key] = res.body.user.id;
    tokens[key] = res.body.tokens.accessToken;
    if (verify) {
      await http()
        .post(`${API}/auth/verify-email/code`)
        .send({ email, code: codeFor(email) })
        .expect(200);
    }
    return res.body;
  }

  let projectId = '';
  let teamId = '';

  beforeAll(async () => {
    // e-mail verification ON for this suite; AppModule is loaded afterwards so that its
    // configuration sees the value
    applyTestEnv({ EMAIL_VERIFICATION_REQUIRED: 'true' });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AppModule } = require('./app.module');
    db = createInMemoryPrisma();
    uni = (await db.university.create({
      data: { name: 'Uni', code: 'UNI', emailDomains: ['uni.edu.sa'] },
    }))!.id;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(db)
      .overrideProvider(SupabaseStorageService)
      .useValue(new FakeStorageService())
      .overrideProvider(AI_TEXT_PROVIDER)
      .useValue(new FakeAiTextProvider())
      .overrideProvider(EMAIL_SENDER)
      .useValue(mail)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    handbooks = app.get(ProjectHandbookService);
  });

  afterAll(async () => {
    await app?.close();
    applyTestEnv();
  });

  describe('academic supervisor self-registration', () => {
    it('refuses a personal or foreign address; a university address registers without a student number', async () => {
      for (const email of ['dr@gmail.com', 'dr@other.edu']) {
        const res = await http()
          .post(`${API}/auth/register`)
          .send({
            email,
            password: PASSWORD,
            role: 'SUPERVISOR',
            universityId: uni,
          })
          .expect(400);
        expect(res.body.code).toBe('SUPERVISOR_UNIVERSITY_EMAIL_REQUIRED');
      }
      const body = await signUp('drnoha', 'SUPERVISOR', false);
      expect(body.user).toMatchObject({
        role: 'SUPERVISOR',
        emailVerified: false,
      });
      expect(body.user.studentNumber ?? null).toBeNull();
      expect(body.emailVerificationRequired).toBe(true);
    });

    it('before verification: no product access, not offered to students, requests refused', async () => {
      const blocked = await http()
        .get(`${API}/projects/supervised`)
        .set(as('drnoha'))
        .expect(403);
      expect(blocked.body.code).toBe('EMAIL_NOT_VERIFIED');

      await signUp('leila', 'STUDENT');
      await signUp('noor', 'STUDENT');
      const list = await http()
        .get(`${API}/supervision-requests/supervisors`)
        .set(as('leila'))
        .expect(200);
      expect(list.body.map((u: any) => u.id)).not.toContain(ids.drnoha);
    });

    it('after verification: dashboard access and offered to students of the university', async () => {
      await http()
        .post(`${API}/auth/verify-email/code`)
        .send({
          email: 'drnoha@uni.edu.sa',
          code: codeFor('drnoha@uni.edu.sa'),
        })
        .expect(200);
      const login = await http()
        .post(`${API}/auth/login`)
        .send({ email: 'drnoha@uni.edu.sa', password: PASSWORD })
        .expect(200);
      tokens.drnoha = login.body.tokens.accessToken;
      expect(login.body.user).toMatchObject({
        role: 'SUPERVISOR',
        emailVerified: true,
      });
      await http()
        .get(`${API}/dashboard/supervisor`)
        .set(as('drnoha'))
        .expect(200);
      const list = await http()
        .get(`${API}/supervision-requests/supervisors`)
        .set(as('leila'))
        .expect(200);
      expect(list.body.map((u: any) => u.id)).toContain(ids.drnoha);
    });
  });

  describe('project setup without an academic supervisor', () => {
    it('the leader completes setup with no supervisor at all', async () => {
      const created = await http()
        .post(`${API}/projects`)
        .set(as('leila'))
        .send({
          name: 'Smart Library',
          description: 'Book finder',
          teamName: 'Team L',
          startDate: day(1),
          endDate: day(120),
        })
        .expect(201);
      projectId = created.body.project.id;
      teamId = created.body.team.id;
      await http()
        .patch(`${API}/projects/${projectId}`)
        .set(as('leila'))
        .send({
          overview: 'A library app',
          objectives: ['Help students'],
          category: 'TECHNOLOGY',
          origin: 'NEW',
          expectedCompletionDate: day(120),
        })
        .expect(200);
      await http()
        .put(`${API}/projects/${projectId}/handbook`)
        .set(as('leila'))
        .attach('file', HANDBOOK_PDF, {
          filename: 'handbook.pdf',
          contentType: 'application/pdf',
        })
        .expect(202);
      await handbooks.whenIdle();

      const setup = await http()
        .get(`${API}/projects/${projectId}/setup`)
        .set(as('leila'))
        .expect(200);
      expect(setup.body.readiness.missingRequirements).toEqual([]);
      const done = await http()
        .post(`${API}/projects/${projectId}/setup/complete`)
        .set(as('leila'))
        .expect(200);
      expect(done.body.setupReadiness).toMatchObject({
        completed: true,
        supervisorRequestStatus: null,
      });
    });

    it('the supervisor sees nothing until invited later from the project and accepted', async () => {
      await http()
        .get(`${API}/projects/${projectId}`)
        .set(as('drnoha'))
        .expect(403);
      const req = await http()
        .post(`${API}/projects/${projectId}/supervision-requests`)
        .set(as('leila'))
        .send({ supervisorEmail: 'drnoha@uni.edu.sa' })
        .expect(201);
      await http()
        .get(`${API}/projects/${projectId}`)
        .set(as('drnoha'))
        .expect(403);
      await http()
        .post(`${API}/supervision-requests/${req.body.id}/accept`)
        .set(as('drnoha'))
        .send({})
        .expect(200);
      await http()
        .get(`${API}/projects/${projectId}`)
        .set(as('drnoha'))
        .expect(200);
    });

    it('an unverified supervisor cannot be invited', async () => {
      await signUp('drlate', 'SUPERVISOR', false);
      const other = await http()
        .post(`${API}/projects`)
        .set(as('noor'))
        .send({ name: 'Campus Map', description: 'Maps' })
        .expect(201);
      const res = await http()
        .post(`${API}/projects/${other.body.project.id}/supervision-requests`)
        .set(as('noor'))
        .send({ supervisorEmail: 'drlate@uni.edu.sa' })
        .expect(400);
      expect(res.body.code).toBe('SUPERVISOR_NOT_VERIFIED');
    });
  });

  describe('stages', () => {
    it('keep their order; the first becomes the current stage; nothing is completed automatically', async () => {
      const titles = ['Analysis', 'Design', 'Development', 'Testing'];
      for (const [i, title] of titles.entries()) {
        await http()
          .post(`${API}/milestones`)
          .set(as('leila'))
          .send({ projectId, title, dueDate: day(20 * (i + 1)), order: i + 1 })
          .expect(201);
      }
      const list = await http()
        .get(`${API}/milestones?projectId=${projectId}`)
        .set(as('leila'))
        .expect(200);
      expect(list.body.items.map((m: any) => m.title)).toEqual(titles);
      expect(list.body.items.map((m: any) => m.status)).toEqual([
        'IN_PROGRESS',
        'PENDING',
        'PENDING',
        'PENDING',
      ]);
      // the supervisor reads the same stages
      const sv = await http()
        .get(`${API}/milestones?projectId=${projectId}`)
        .set(as('drnoha'))
        .expect(200);
      expect(sv.body.items).toHaveLength(4);
    });

    it('moving to the next stage follows the leader-only rule', async () => {
      const list = await http()
        .get(`${API}/milestones?projectId=${projectId}`)
        .set(as('leila'))
        .expect(200);
      const second = list.body.items[1].id;
      await http()
        .post(`${API}/teams/${teamId}/student-invitations`)
        .set(as('leila'))
        .send({ studentNumber: 'S-noor' })
        .expect(201);
      const inv = await http()
        .get(`${API}/team-invitations/incoming`)
        .set(as('noor'))
        .expect(200);
      await http()
        .post(`${API}/team-invitations/${inv.body[0].id}/accept`)
        .set(as('noor'))
        .expect(200);
      await http()
        .patch(`${API}/milestones/${second}`)
        .set(as('noor'))
        .send({ status: 'IN_PROGRESS' })
        .expect(403);
      await http()
        .patch(`${API}/milestones/${second}`)
        .set(as('drnoha'))
        .send({ status: 'IN_PROGRESS' })
        .expect(403);
      const ok = await http()
        .patch(`${API}/milestones/${second}`)
        .set(as('leila'))
        .send({ status: 'IN_PROGRESS' })
        .expect(200);
      expect(ok.body.status).toBe('IN_PROGRESS');
    });
  });

  describe('task assignment', () => {
    it('the leader is listed among the members and can assign a task to themself', async () => {
      const ws = await http()
        .get(`${API}/projects/${projectId}`)
        .set(as('leila'))
        .expect(200);
      const memberIds = ws.body.team.members.map((m: any) => m.userId);
      expect(memberIds).toEqual(expect.arrayContaining([ids.leila, ids.noor]));
      const task = await http()
        .post(`${API}/tasks`)
        .set(as('leila'))
        .send({
          projectId,
          title: 'Write the plan',
          assignedStudentId: ids.leila,
        })
        .expect(201);
      expect(task.body.assignedStudentId).toBe(ids.leila);
      const unassigned = await http()
        .post(`${API}/tasks`)
        .set(as('leila'))
        .send({ projectId, title: 'Unassigned task' })
        .expect(201);
      expect(unassigned.body.assignedStudentId ?? null).toBeNull();
    });
  });

  describe('project files', () => {
    const upload = (who: string, extra: Record<string, string> = {}) => {
      let r = http()
        .post(`${API}/documents/upload`)
        .set(as(who))
        .field('projectId', projectId)
        .field('title', 'Meeting notes');
      for (const [k, v] of Object.entries(extra)) r = r.field(k, v);
      return r.attach('file', DOC_PDF, {
        filename: 'notes.pdf',
        contentType: 'application/pdf',
      });
    };
    const reviewNotices = () =>
      db.notification.rows.filter(
        (n: any) => n.userId === ids.drnoha && n.type === 'DOCUMENT_SUBMITTED',
      );

    it('a regular upload is available at once, UPLOADED, with no review notice', async () => {
      const before = reviewNotices().length;
      const res = await upload('noor').expect(201);
      expect(res.body.reviewStatus).toBe('UPLOADED');
      const list = await http()
        .get(`${API}/documents?projectId=${projectId}`)
        .set(as('leila'))
        .expect(200);
      expect(list.body.map((d: any) => d.id)).toContain(res.body.id);
      expect(reviewNotices()).toHaveLength(before);
      // a new version of a regular file stays regular
      const v2 = await http()
        .post(`${API}/documents/${res.body.id}/versions`)
        .set(as('noor'))
        .attach('file', DOC_PDF, {
          filename: 'notes-2.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);
      expect(v2.body.reviewStatus).toBe('UPLOADED');
      expect(v2.body.currentVersion).toBe(2);
      expect(reviewNotices()).toHaveLength(before);

      // sent for review later: SUBMITTED + one notice; only the uploader or the leader may do it
      await http()
        .post(`${API}/documents/${res.body.id}/submit-for-review`)
        .set(as('drnoha'))
        .expect(403);
      const sent = await http()
        .post(`${API}/documents/${res.body.id}/submit-for-review`)
        .set(as('leila'))
        .expect(201);
      expect(sent.body.reviewStatus).toBe('SUBMITTED');
      expect(reviewNotices()).toHaveLength(before + 1);
      // idempotent
      await http()
        .post(`${API}/documents/${res.body.id}/submit-for-review`)
        .set(as('leila'))
        .expect(201);
      expect(reviewNotices()).toHaveLength(before + 1);
    });

    it('an upload sent for review starts SUBMITTED and notifies the supervisor', async () => {
      const before = reviewNotices().length;
      const res = await upload('noor', { submitForReview: 'true' }).expect(201);
      expect(res.body.reviewStatus).toBe('SUBMITTED');
      expect(reviewNotices()).toHaveLength(before + 1);
      // after a decision, a new version is a resubmission
      await http()
        .post(`${API}/feedback`)
        .set(as('drnoha'))
        .send({
          documentId: res.body.id,
          status: 'CHANGES_REQUESTED',
          comment: 'Add the method',
        })
        .expect(201);
      const v2 = await http()
        .post(`${API}/documents/${res.body.id}/versions`)
        .set(as('noor'))
        .attach('file', DOC_PDF, {
          filename: 'v2.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);
      expect(v2.body.reviewStatus).toBe('SUBMITTED');
    });
  });
});
