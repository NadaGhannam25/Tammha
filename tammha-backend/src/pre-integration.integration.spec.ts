import { readFileSync } from 'fs';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';
import { configureApp } from './app.setup';
import {
  createInMemoryPrisma,
  InMemoryPrisma,
} from './testing/in-memory-prisma';
import { FakeStorageService } from './testing/fake-storage';
import { FakeAiTextProvider } from './testing/fake-ai-provider';
import { FakeEmailSender } from './testing/fake-email-sender';
import { SupabaseStorageService } from '@modules/documents/supabase-storage.service';
import {
  AI_TEXT_PROVIDER,
  AiProviderError,
} from '@/integrations/ai/ai.provider';
import { ProjectHandbookService } from '@modules/ai-support/handbook/project-handbook.service';
import { EMAIL_SENDER } from '@/integrations/email/email.sender';

/**
 * Pre-integration features on the real AppModule (in-memory database, fake storage, fake
 * Gemini, fake e-mail): official university handbooks, selection per project (also from
 * another university) or an own PDF, the seven-topic AI summary with checked page
 * references, handbook task extraction with selective, idempotent apply, the supervisor
 * AI restrictions, several projects per student, meeting notes, task comments and the
 * shared reference values.
 */
const API = '/api/v1';
const HANDBOOK_PDF = readFileSync(
  join(__dirname, 'testing/fixtures/handbook-sample.pdf'),
);

describe('Pre-integration features (AppModule integration)', () => {
  let app: INestApplication;
  let db: InMemoryPrisma;
  const storage = new FakeStorageService();
  const ai = new FakeAiTextProvider();
  const mail = new FakeEmailSender();
  const http = () => request(app.getHttpServer());
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const as = (k: string) => ({ Authorization: `Bearer ${tokens[k]}` });
  const lib: Record<string, string> = {};
  const p: Record<string, string> = {};

  async function seed(
    key: string,
    role: 'STUDENT' | 'SUPERVISOR' | 'ADMIN',
    universityId: string | null,
  ) {
    const email = `${key}@uni.test`;
    const u = await db.user.create({
      data: {
        email,
        password: 'unused',
        firstName: key[0].toUpperCase() + key.slice(1),
        lastName: 'Tester',
        role,
        universityId,
        emailVerifiedAt: new Date(),
        ...(role === 'STUDENT' && {
          studentNumber: `SN-${key.toUpperCase()}`,
          universityEmail: email,
          universityEmailVerifiedAt: new Date(),
        }),
      },
    });
    ids[key] = u!.id;
    tokens[key] = app.get(JwtService).sign({ sub: u!.id, email, role });
  }

  beforeAll(async () => {
    db = createInMemoryPrisma();
    await db.university.create({
      data: { id: 'uni-a', name: 'Almaarefa University', code: 'UM' },
    });
    await db.university.create({
      data: { id: 'uni-b', name: 'Najran University', code: 'NU' },
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(db)
      .overrideProvider(SupabaseStorageService)
      .useValue(storage)
      .overrideProvider(AI_TEXT_PROVIDER)
      .useValue(ai)
      .overrideProvider(EMAIL_SENDER)
      .useValue(mail)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    await seed('admin', 'ADMIN', null);
    for (const s of ['leila', 'noor', 'omar'])
      await seed(s, 'STUDENT', 'uni-a');
    await seed('supA', 'SUPERVISOR', 'uni-a');
  });

  afterAll(async () => {
    await app?.close();
  });

  // ==================================================================
  describe('Several projects per student', () => {
    it('a student creates two projects; each has its own team, leader and invitation', async () => {
      for (const name of ['Smart Campus', 'Health Tracker']) {
        const res = await http()
          .post(`${API}/projects`)
          .set(as('leila'))
          .send({ name })
          .expect(201);
        p[name] = res.body.project.id;
        p[`${name}:team`] = res.body.team.id;
        p[`${name}:code`] = res.body.invitation.code;
      }
      await http()
        .post(`${API}/teams/join`)
        .set(as('noor'))
        .send({ code: p['Smart Campus:code'] })
        .expect(200);
      const mine = await http()
        .get(`${API}/projects`)
        .set(as('leila'))
        .expect(200);
      expect(mine.body.map((w: any) => w.project.name).sort()).toEqual([
        'Health Tracker',
        'Smart Campus',
      ]);
      const teams = await http()
        .get(`${API}/teams`)
        .set(as('leila'))
        .expect(200);
      expect(teams.body).toHaveLength(2);
    });

    it('projects stay separate: tasks, access and the dashboard', async () => {
      await http()
        .post(`${API}/tasks`)
        .set(as('leila'))
        .send({ projectId: p['Health Tracker'], title: 'Private task' })
        .expect(201);
      await http()
        .get(`${API}/projects/${p['Health Tracker']}`)
        .set(as('noor'))
        .expect(403);
      const noorTasks = await http()
        .get(`${API}/tasks`)
        .set(as('noor'))
        .expect(200);
      expect(JSON.stringify(noorTasks.body)).not.toContain('Private task');
      const dash = await http()
        .get(`${API}/dashboard/student?projectId=${p['Smart Campus']}`)
        .set(as('leila'))
        .expect(200);
      expect(dash.body.project.id).toBe(p['Smart Campus']);
      expect(dash.body.projects).toHaveLength(2);
      await http()
        .get(`${API}/dashboard/student?projectId=${p['Health Tracker']}`)
        .set(as('noor'))
        .expect(403);
      // a member of one project can lead another
      const own = await http()
        .post(`${API}/projects`)
        .set(as('noor'))
        .send({ name: 'Noor Lab' })
        .expect(201);
      expect(own.body.viewer).toMatchObject({ isLeader: true });
      const ws = await http()
        .get(`${API}/projects/${p['Smart Campus']}`)
        .set(as('noor'))
        .expect(200);
      expect(ws.body.viewer).toMatchObject({ isLeader: false });
    });
  });

  // ==================================================================
  describe('Meeting notes', () => {
    let meetingId = '';

    beforeAll(async () => {
      const req = await http()
        .post(`${API}/projects/${p['Smart Campus']}/supervision-requests`)
        .set(as('leila'))
        .send({ supervisorEmail: 'supa@uni.test' })
        .expect(201);
      await http()
        .post(`${API}/supervision-requests/${req.body.id}/accept`)
        .set(as('supA'))
        .send({})
        .expect(200);
      const m = await http()
        .post(`${API}/meetings`)
        .set(as('leila'))
        .send({
          projectId: p['Smart Campus'],
          title: 'Weekly sync',
          scheduledAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
          durationMinutes: 30,
        })
        .expect(201);
      meetingId = m.body.id;
    });

    it("each author keeps their own notes; the supervisor's are shared read-only", async () => {
      const empty = await http()
        .get(`${API}/meetings/${meetingId}/notes`)
        .set(as('noor'))
        .expect(200);
      expect(empty.body).toMatchObject({
        exists: false,
        content: '',
        shared: [],
      });
      const created = await http()
        .put(`${API}/meetings/${meetingId}/notes`)
        .set(as('noor'))
        .send({ content: '  Agreed: survey by Thursday.  ' })
        .expect(200);
      expect(created.body).toMatchObject({
        exists: true,
        content: 'Agreed: survey by Thursday.',
        createdBy: { id: ids.noor },
        updatedBy: { id: ids.noor },
        visibility: 'PRIVATE',
      });
      const sup = await http()
        .put(`${API}/meetings/${meetingId}/notes`)
        .set(as('supA'))
        .send({ content: 'Review chapter 2 next week.' })
        .expect(200);
      expect(sup.body).toMatchObject({
        content: 'Review chapter 2 next week.',
        createdBy: { id: ids.supA },
        visibility: 'SHARED_WITH_TEAM',
      });
      // the supervisor did not overwrite the student's notes
      expect(db.meetingNotes.rows).toHaveLength(2);
      const noor = await http()
        .get(`${API}/meetings/${meetingId}/notes`)
        .set(as('noor'))
        .expect(200);
      expect(noor.body.content).toBe('Agreed: survey by Thursday.');
      expect(noor.body.shared).toEqual([
        expect.objectContaining({ content: 'Review chapter 2 next week.' }),
      ]);
      const meeting = await http()
        .get(`${API}/meetings/${meetingId}`)
        .set(as('leila'))
        .expect(200);
      // leila has no notes of her own, but can read the supervisor's
      expect(meeting.body.hasNotes).toBe(true);
    });

    it('outsiders cannot read or write; empty notes are refused', async () => {
      await http()
        .get(`${API}/meetings/${meetingId}/notes`)
        .set(as('omar'))
        .expect(403);
      await http()
        .put(`${API}/meetings/${meetingId}/notes`)
        .set(as('omar'))
        .send({ content: 'x' })
        .expect(403);
      const blank = await http()
        .put(`${API}/meetings/${meetingId}/notes`)
        .set(as('noor'))
        .send({ content: '   ' })
        .expect(400);
      expect(blank.body.code).toBe('MEETING_NOTES_EMPTY');
      await http()
        .get(`${API}/meetings/nope/notes`)
        .set(as('noor'))
        .expect(404);
    });
  });

  // ==================================================================
  describe('Task comments', () => {
    let taskId = '';
    let commentId = '';

    beforeAll(async () => {
      taskId = (
        await http()
          .post(`${API}/tasks`)
          .set(as('leila'))
          .send({
            projectId: p['Smart Campus'],
            title: 'Survey',
            assignedStudentId: ids.noor,
          })
          .expect(201)
      ).body.id;
    });

    it('team members comment; author and time are stored; the creator is notified', async () => {
      const res = await http()
        .post(`${API}/tasks/${taskId}/comments`)
        .set(as('noor'))
        .send({ content: '  Draft uploaded  ' })
        .expect(201);
      commentId = res.body.id;
      expect(res.body).toMatchObject({
        taskId,
        projectId: p['Smart Campus'],
        content: 'Draft uploaded',
        author: { id: ids.noor },
        isMine: true,
        edited: false,
        createdAt: expect.any(String),
      });
      const notified = db.notification.rows.filter(
        (n: any) => n.type === 'COMMENT_ADDED' && n.data?.taskId === taskId,
      );
      expect(notified.map((n: any) => n.userId)).toEqual([ids.leila]);
      await http()
        .post(`${API}/tasks/${taskId}/comments`)
        .set(as('leila'))
        .send({ content: 'Thanks!' })
        .expect(201);
    });

    it('the supervisor reads them (and uses task feedback to write); outsiders cannot', async () => {
      const list = await http()
        .get(`${API}/tasks/${taskId}/comments`)
        .set(as('supA'))
        .expect(200);
      expect(list.body.items.map((c: any) => c.content)).toEqual([
        'Draft uploaded',
        'Thanks!',
      ]);
      await http()
        .post(`${API}/tasks/${taskId}/comments`)
        .set(as('supA'))
        .send({ content: 'x' })
        .expect(403);
      await http()
        .get(`${API}/tasks/${taskId}/comments`)
        .set(as('omar'))
        .expect(403);
      await http()
        .post(`${API}/tasks/${taskId}/feedback`)
        .set(as('supA'))
        .send({ comment: 'Add the sample size.' })
        .expect(201);
      const feedback = await http()
        .get(`${API}/tasks/${taskId}/feedback`)
        .set(as('noor'))
        .expect(200);
      expect(feedback.body.items[0].comment).toBe('Add the sample size.');
    });

    it('only the author edits; the author or the leader deletes', async () => {
      await http()
        .patch(`${API}/tasks/${taskId}/comments/${commentId}`)
        .set(as('leila'))
        .send({ content: 'changed' })
        .expect(403);
      const edited = await http()
        .patch(`${API}/tasks/${taskId}/comments/${commentId}`)
        .set(as('noor'))
        .send({ content: 'Draft v2 uploaded' })
        .expect(200);
      expect(edited.body).toMatchObject({
        content: 'Draft v2 uploaded',
        edited: true,
      });
      const empty = await http()
        .post(`${API}/tasks/${taskId}/comments`)
        .set(as('noor'))
        .send({ content: '  ' })
        .expect(400);
      expect(empty.body.code).toBe('COMMENT_EMPTY');
      await http()
        .delete(`${API}/tasks/${taskId}/comments/${commentId}`)
        .set(as('leila'))
        .expect(200);
      expect(db.comment.rows.some((c: any) => c.id === commentId)).toBe(false);
    });
  });

  // ==================================================================
  // Handbooks: official university PDFs, selection per project, own upload
  // ==================================================================
  describe('University handbooks', () => {
    const upload = (
      universityId: string,
      file: Buffer,
      name = 'handbook.pdf',
    ) =>
      http()
        .put(`${API}/admin/universities/${universityId}/handbook`)
        .set(as('admin'))
        .field('title', `Official handbook ${universityId}`)
        .attach('file', file, {
          filename: name,
          contentType: 'application/pdf',
        });

    beforeAll(async () => {
      // pnu: set up but no PDF yet; tabuk: not created at all; other: not a handbook university
      await db.university.create({
        data: {
          id: 'uni-c',
          name: 'Princess Nourah bint Abdulrahman University',
          code: 'PNU',
        },
      });
      await db.university.create({
        data: { id: 'uni-x', name: 'Other University', code: 'OTHER' },
      });
    });

    it('an ADMIN uploads the official PDF of a university; invalid files are refused', async () => {
      await http()
        .put(`${API}/admin/universities/uni-a/handbook`)
        .set(as('leila'))
        .field('title', 'x')
        .attach('file', HANDBOOK_PDF, 'h.pdf')
        .expect(403);
      const notPdf = await upload('uni-a', Buffer.from('hello world'), 'a.pdf');
      expect(notPdf.status).toBe(400);
      expect(notPdf.body.code).toBe('HANDBOOK_NOT_PDF');
      const noText = await upload(
        'uni-a',
        Buffer.from('%PDF-1.4\n%%EOF\n'),
        'scan.pdf',
      );
      expect([400, 422]).toContain(noText.status);
      expect(['HANDBOOK_UNREADABLE', 'HANDBOOK_NO_TEXT']).toContain(
        noText.body.code,
      );
      await upload('uni-a', HANDBOOK_PDF, 'alpha-gp-handbook.pdf').expect(200);
      await upload('uni-b', HANDBOOK_PDF, 'beta-gp-handbook.pdf').expect(200);
      // a university outside the four can hold a PDF, but it is never offered
      await upload('uni-x', HANDBOOK_PDF, 'other.pdf').expect(200);
    });

    it('students see exactly the four handbook universities, with the real file name or null', async () => {
      const res = await http()
        .get(`${API}/handbooks/universities`)
        .set(as('noor'))
        .expect(200);
      expect(res.body.map((u: any) => u.key)).toEqual([
        'almaarefa',
        'najran',
        'pnu',
        'tabuk',
      ]);
      expect(res.body[0]).toMatchObject({
        key: 'almaarefa',
        code: 'UM',
        name: { en: 'Almaarefa University', ar: 'جامعة المعرفة' },
        universityId: 'uni-a',
        isMyUniversity: true,
        handbook: { fileName: 'alpha-gp-handbook.pdf', pageCount: 4 },
      });
      expect(res.body[1]).toMatchObject({
        key: 'najran',
        universityId: 'uni-b',
        isMyUniversity: false,
        handbook: { fileName: 'beta-gp-handbook.pdf' },
      });
      // set up without a PDF / not created yet: listed, not available (nothing invented)
      expect(res.body[2]).toMatchObject({
        key: 'pnu',
        universityId: 'uni-c',
        handbook: null,
      });
      expect(res.body[3]).toMatchObject({
        key: 'tabuk',
        name: { ar: 'جامعة تبوك' },
        universityId: null,
        isMyUniversity: false,
        handbook: null,
      });
      expect(JSON.stringify(res.body)).not.toContain('Other University');
      lib.betaVersion = res.body[1].handbook.versionId;
      // the PDF itself through a short-lived signed URL; none for pnu / tabuk / others
      const file = await http()
        .get(`${API}/handbooks/universities/najran/file`)
        .set(as('supA'))
        .expect(200);
      expect(file.body.fileName).toBe('beta-gp-handbook.pdf');
      for (const key of ['pnu', 'tabuk']) {
        const missing = await http()
          .get(`${API}/handbooks/universities/${key}/file`)
          .set(as('noor'))
          .expect(404);
        expect(missing.body.code).toBe('UNIVERSITY_HANDBOOK_NOT_AVAILABLE');
      }
      const other = await http()
        .get(`${API}/handbooks/universities/uni-x/file`)
        .set(as('noor'))
        .expect(404);
      expect(other.body.code).toBe('UNIVERSITY_NOT_IN_HANDBOOK_LIST');
      await http().get(`${API}/handbooks/universities`).expect(401);
    });

    it('the retired college / major / version browsing routes are gone', async () => {
      await http()
        .get(`${API}/library/universities`)
        .set(as('noor'))
        .expect(404);
      await http()
        .post(`${API}/admin/library/colleges`)
        .set(as('admin'))
        .send({ universityId: 'uni-a', name: 'x' })
        .expect(404);
    });

    it("the leader selects another university's handbook; nobody's university changes", async () => {
      const url = `${API}/projects/${p['Smart Campus']}/handbook/university-selection`;
      const denied = await http()
        .put(url)
        .set(as('noor'))
        .send({ universityKey: 'najran' })
        .expect(403);
      expect(denied.body.code).toBe('NOT_TEAM_LEADER');
      await http()
        .put(url)
        .set(as('omar'))
        .send({ universityKey: 'najran' })
        .expect(403); // not in this project
      await http()
        .put(url)
        .set(as('supA'))
        .send({ universityKey: 'najran' })
        .expect(403); // supervisors never change a project's handbook
      const none = await http()
        .put(url)
        .set(as('leila'))
        .send({ universityKey: 'pnu' })
        .expect(404);
      expect(none.body.code).toBe('UNIVERSITY_HANDBOOK_NOT_AVAILABLE');
      const notCreated = await http()
        .put(url)
        .set(as('leila'))
        .send({ universityKey: 'tabuk' })
        .expect(404);
      expect(notCreated.body.code).toBe('UNIVERSITY_HANDBOOK_NOT_AVAILABLE');
      const unknown = await http()
        .put(url)
        .set(as('leila'))
        .send({ universityKey: 'uni-x' }) // a university outside the four
        .expect(400);
      expect(JSON.stringify(unknown.body)).toContain('universityKey');
      const res = await http()
        .put(url)
        .set(as('leila'))
        .send({ universityKey: 'najran' })
        .expect(200);
      expect(res.body).toMatchObject({
        state: 'READY',
        source: 'LIBRARY',
        libraryVersion: {
          id: lib.betaVersion,
          fileName: 'beta-gp-handbook.pdf',
          universityName: 'Najran University',
          universityKey: 'najran',
        },
        canSelect: true,
        myUniversityHandbookAvailable: true,
      });
      expect(
        db.user.rows.find((u: any) => u.id === ids.leila)!.universityId,
      ).toBe('uni-a');
      const setup = await http()
        .get(`${API}/projects/${p['Smart Campus']}/setup`)
        .set(as('leila'))
        .expect(200);
      expect(JSON.stringify(setup.body)).not.toContain('HANDBOOK_REQUIRED');
      // the other project of the same student is not affected
      const other = await http()
        .get(`${API}/projects/${p['Health Tracker']}/handbook`)
        .set(as('leila'))
        .expect(200);
      expect(other.body).toMatchObject({ state: 'NONE', source: 'UPLOAD' });
      // an official version used by a project cannot be deleted
      const inUse = await http()
        .delete(`${API}/admin/universities/uni-b/handbook`)
        .set(as('admin'))
        .expect(409);
      expect(inUse.body.code).toBe('HANDBOOK_VERSION_IN_USE');
    });

    it('the leader uploads an own PDF for the other project (validated, project only)', async () => {
      const url = `${API}/projects/${p['Health Tracker']}/handbook`;
      const bad = await http()
        .put(url)
        .set(as('leila'))
        .field('title', 'Our handbook')
        .attach('file', Buffer.from('not a pdf'), {
          filename: 'notes.pdf',
          contentType: 'application/pdf',
        });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('HANDBOOK_NOT_PDF');
      await http()
        .put(url)
        .set(as('leila'))
        .field('title', 'Our handbook')
        .attach('file', HANDBOOK_PDF, {
          filename: 'our-handbook.pdf',
          contentType: 'application/pdf',
        })
        .expect(202);
      await app.get(ProjectHandbookService).whenIdle();
      const state = await http().get(url).set(as('leila')).expect(200);
      expect(state.body).toMatchObject({
        state: 'READY',
        source: 'UPLOAD',
        active: { fileName: 'our-handbook.pdf' },
      });
      // a student of another project cannot read it
      await http().get(url).set(as('noor')).expect(403);
    });
  });

  // ==================================================================
  describe('Handbook summary: seven fixed topics', () => {
    let pages: string[] = [];
    const firstWords = (text: string, n = 6) =>
      text.replace(/\s+/g, ' ').trim().split(' ').slice(0, n).join(' ');
    const summaryUrl = () =>
      `${API}/projects/${p['Smart Campus']}/handbook/summary`;
    const TOPICS = [
      'OVERVIEW',
      'REPORT_STRUCTURE',
      'GRADING',
      'SUBMISSION',
      'PROPOSAL',
      'WEEKLY_REPORTS',
      'FINAL_DEFENSE',
    ];

    beforeAll(() => {
      const version = db.universityHandbook.rows.find(
        (v: any) => v.id === lib.betaVersion,
      )!;
      pages = (version.extractedText as string).split('\f');
    });

    it('always returns the seven topics in order; page references are checked', async () => {
      ai.reset();
      ai.nextJson({
        topics: [
          {
            id: 'GRADING',
            found: true,
            summary: 'Grades as stated in the handbook.',
            points: [
              {
                text: 'Invented rule',
                pages: [3],
                quote: 'students must publish three papers',
              },
            ],
          },
          {
            id: 'OVERVIEW',
            found: true,
            summary: 'What the handbook covers.',
            points: [
              { text: 'Correct page', pages: [2], quote: firstWords(pages[1]) },
              { text: 'Wrong page', pages: [1], quote: firstWords(pages[2]) },
            ],
          },
          { id: 'SUBMISSION', found: true, summary: '', points: [] },
          { id: 'WEEKLY_REPORTS', found: false, summary: 'x', points: [] },
          { id: 'NOT_A_TOPIC', found: true, summary: 'ignored', points: [] },
        ],
      });
      const res = await http()
        .post(summaryUrl())
        .set(as('noor'))
        .send({ language: 'en' })
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'READY',
        language: 'en',
        handbook: {
          source: 'LIBRARY',
          id: lib.betaVersion,
          fileName: 'beta-gp-handbook.pdf',
          universityName: 'Najran University',
        },
        coverage: { pagesIncluded: 4, truncated: false },
        advisoryOnly: true,
      });
      expect(res.body.topics.map((t: any) => t.id)).toEqual(TOPICS);
      expect(res.body.topics[2].title).toEqual({
        ar: 'توزيع الدرجات ومعايير التقييم',
        en: 'Grading Distribution and Evaluation Criteria',
      });
      const byId = Object.fromEntries(
        res.body.topics.map((t: any) => [t.id, t]),
      );
      expect(
        byId.OVERVIEW.points.map((x: any) => [x.text, x.pages, x.verified]),
      ).toEqual([
        ['Correct page', [2], true],
        ['Wrong page', [3], true], // corrected to where the quote really is
      ]);
      expect(byId.GRADING).toMatchObject({ found: true });
      expect(byId.GRADING.points[0]).toMatchObject({
        pages: [],
        verified: false, // never shown as verified handbook content
      });
      // missing / empty topics are "not found" (UI: لا توجد نتائج), not errors
      for (const id of [
        'REPORT_STRUCTURE',
        'SUBMISSION',
        'PROPOSAL',
        'WEEKLY_REPORTS',
        'FINAL_DEFENSE',
      ]) {
        expect(byId[id]).toMatchObject({
          found: false,
          summary: '',
          points: [],
        });
      }
      expect(res.body.stats).toEqual({
        topics: 7,
        foundTopics: 2,
        points: 3,
        verifiedPoints: 2,
      });
      expect(ai.requests[0].system).toMatch(/Never invent/);
      expect(ai.requests[0].system).toContain('REPORT_STRUCTURE');
      expect(ai.lastPrompt).toContain('[Page 1]');
      expect(ai.lastPrompt).toContain('in English');
      expect(db.aISupport.rows.at(-1)).toMatchObject({
        kind: 'HANDBOOK_EXPLANATION',
        status: 'COMPLETED',
        projectId: p['Smart Campus'],
        userId: ids.noor,
      });
    });

    it('the summary is reused (no AI call); the supervisor reads it; outsiders cannot', async () => {
      const before = ai.requests.length;
      const again = await http()
        .post(summaryUrl())
        .set(as('leila'))
        .send({ language: 'en' })
        .expect(200);
      expect(again.body.status).toBe('READY');
      expect(ai.requests.length).toBe(before);
      const sup = await http()
        .get(`${summaryUrl()}?language=en`)
        .set(as('supA'))
        .expect(200);
      expect(sup.body.topics).toHaveLength(7);
      const arabic = await http()
        .get(`${summaryUrl()}?language=ar`)
        .set(as('leila'))
        .expect(200);
      expect(arabic.body).toMatchObject({
        status: 'NOT_GENERATED',
        topics: [],
        stats: null,
      });
      await http().get(summaryUrl()).set(as('omar')).expect(403);
    });

    it('a malformed answer or a provider failure is an error, never a summary', async () => {
      ai.nextJson({ sections: [{ title: 'free-form' }] }); // no topics list
      const bad = await http()
        .post(summaryUrl())
        .set(as('leila'))
        .send({ language: 'ar' })
        .expect(502);
      expect(bad.body.code).toBe('AI_INVALID_RESPONSE');
      ai.nextText('not json at all');
      await http()
        .post(summaryUrl())
        .set(as('leila'))
        .send({ language: 'ar' })
        .expect(502);
      ai.nextError(new AiProviderError('AI_PROVIDER_TIMEOUT'));
      const slow = await http()
        .post(summaryUrl())
        .set(as('leila'))
        .send({ language: 'ar' })
        .expect(504);
      expect(slow.body.code).toBe('AI_PROVIDER_TIMEOUT');
      expect(
        db.handbookExplanation.rows.some(
          (r: any) =>
            r.universityHandbookId === lib.betaVersion && r.language === 'ar',
        ),
      ).toBe(false);
      const failed = db.aISupport.rows.filter(
        (r: any) => r.kind === 'HANDBOOK_EXPLANATION' && r.status === 'FAILED',
      );
      expect(failed.map((r: any) => r.errorCode)).toEqual([
        'AI_INVALID_RESPONSE',
        'AI_INVALID_RESPONSE',
        'AI_PROVIDER_TIMEOUT',
      ]);
    });

    it("a handbook without the topics: all seven are 'not found' (own upload)", async () => {
      ai.nextJson({ topics: [] });
      const res = await http()
        .post(`${API}/projects/${p['Health Tracker']}/handbook/summary`)
        .set(as('leila'))
        .send({ language: 'ar' })
        .expect(200);
      expect(res.body.handbook).toMatchObject({
        source: 'PROJECT',
        fileName: 'our-handbook.pdf',
        universityName: null,
      });
      expect(res.body.topics).toHaveLength(7);
      expect(res.body.topics.every((t: any) => t.found === false)).toBe(true);
      expect(res.body.stats.foundTopics).toBe(0);
    });

    it('no handbook selected: 404 HANDBOOK_NOT_FOUND (no AI call)', async () => {
      const before = ai.requests.length;
      const own = await http()
        .post(`${API}/projects`)
        .set(as('omar'))
        .send({ name: 'Omar Project' })
        .expect(201);
      p['Omar Project'] = own.body.project.id;
      const res = await http()
        .post(`${API}/projects/${p['Omar Project']}/handbook/summary`)
        .set(as('omar'))
        .send({})
        .expect(404);
      expect(res.body.code).toBe('HANDBOOK_NOT_FOUND');
      expect(ai.requests.length).toBe(before);
    });
  });

  // ==================================================================
  describe('Tasks from the handbook: suggestions, selection, no duplicates', () => {
    const extractUrl = () =>
      `${API}/projects/${p['Smart Campus']}/handbook/task-suggestions`;
    const applyUrl = () =>
      `${API}/projects/${p['Smart Campus']}/ai-task-suggestions/apply`;

    it('members see suggestions taken from the handbook; unverifiable ones are dropped', async () => {
      ai.reset();
      const res = await http()
        .post(extractUrl())
        .set(as('noor'))
        .send({ language: 'en' })
        .expect(200);
      expect(res.body).toMatchObject({
        handbook: { source: 'LIBRARY', fileName: 'beta-gp-handbook.pdf' },
        dropped: { unverified: 1, duplicates: 0 },
        canApply: false, // only the leader applies
        advisoryOnly: true,
      });
      expect(res.body.suggestions).toHaveLength(1);
      expect(res.body.suggestions[0]).toMatchObject({
        id: 't1',
        title: 'Prepare the project proposal',
        pages: [1],
      });
      expect(ai.lastPrompt).toContain('TASK: HANDBOOK TASKS');
      expect(ai.lastPrompt).toContain('[Page 1]');
      // a member cannot apply (team leader only)
      const denied = await http()
        .post(applyUrl())
        .set(as('noor'))
        .send({
          aiRequestId: res.body.aiRequestId,
          items: [{ suggestionId: 't1' }],
        })
        .expect(403);
      expect(denied.body.code).toBe('NOT_TEAM_LEADER');
      // supervisors cannot extract tasks
      await http().post(extractUrl()).set(as('supA')).send({}).expect(403);
      await http().post(extractUrl()).set(as('omar')).send({}).expect(403);
    });

    it('the leader applies only the selected suggestion, once', async () => {
      ai.nextJson({
        tasks: [
          {
            title: 'Prepare the project proposal',
            description: 'From the handbook',
            priority: 'HIGH',
            estimatedDays: 5,
            pages: [1],
            quote: (
              db.universityHandbook.rows.find(
                (v: any) => v.id === lib.betaVersion,
              )!.extractedText as string
            )
              .split('\f')[0]
              .replace(/\s+/g, ' ')
              .trim()
              .split(' ')
              .slice(0, 6)
              .join(' '),
          },
          {
            title: 'Write the weekly report',
            description: 'From the handbook',
            priority: 'MEDIUM',
            estimatedDays: 1,
            pages: [1],
            quote: (
              db.universityHandbook.rows.find(
                (v: any) => v.id === lib.betaVersion,
              )!.extractedText as string
            )
              .split('\f')[0]
              .replace(/\s+/g, ' ')
              .trim()
              .split(' ')
              .slice(0, 6)
              .join(' '),
          },
        ],
      });
      const res = await http()
        .post(extractUrl())
        .set(as('leila'))
        .send({})
        .expect(200);
      expect(res.body.canApply).toBe(true);
      expect(res.body.suggestions.map((s: any) => s.id)).toEqual(['t1', 't2']);
      const tasksBefore = db.task.rows.length;
      const applied = await http()
        .post(applyUrl())
        .set(as('leila'))
        .send({
          aiRequestId: res.body.aiRequestId,
          items: [{ suggestionId: 't1' }],
        })
        .expect(200);
      expect(applied.body.created).toHaveLength(1);
      expect(applied.body.created[0]).toMatchObject({
        title: 'Prepare the project proposal',
        status: 'TODO',
        projectId: p['Smart Campus'],
      });
      expect(db.task.rows.length).toBe(tasksBefore + 1); // t2 was not selected
      // applying again never duplicates
      const again = await http()
        .post(applyUrl())
        .set(as('leila'))
        .send({
          aiRequestId: res.body.aiRequestId,
          items: [{ suggestionId: 't1' }],
        })
        .expect(200);
      expect(again.body.created).toHaveLength(0);
      expect(again.body.alreadyApplied).toHaveLength(1);
      expect(db.task.rows.length).toBe(tasksBefore + 1);
      // a new extraction does not suggest the existing task again
      const next = await http()
        .post(extractUrl())
        .set(as('leila'))
        .send({})
        .expect(200);
      expect(next.body.suggestions).toHaveLength(0);
      expect(next.body.dropped).toEqual({ unverified: 1, duplicates: 1 });
      // the request of another project cannot be applied here
      const foreign = await http()
        .post(
          `${API}/projects/${p['Health Tracker']}/ai-task-suggestions/apply`,
        )
        .set(as('leila'))
        .send({
          aiRequestId: res.body.aiRequestId,
          items: [{ suggestionId: 't2' }],
        })
        .expect(404);
      expect(foreign.body.code).toBe('AI_REQUEST_NOT_FOUND');
    });

    it('empty and malformed answers', async () => {
      ai.nextJson({ tasks: [] });
      const empty = await http()
        .post(extractUrl())
        .set(as('leila'))
        .send({})
        .expect(200);
      expect(empty.body.suggestions).toEqual([]);
      ai.nextText('{"title": "no list"}');
      const bad = await http()
        .post(extractUrl())
        .set(as('leila'))
        .send({})
        .expect(502);
      expect(bad.body.code).toBe('AI_INVALID_RESPONSE');
      ai.nextError(new AiProviderError('AI_PROVIDER_UNAVAILABLE'));
      const down = await http()
        .post(extractUrl())
        .set(as('leila'))
        .send({})
        .expect(503);
      expect(down.body.code).toBe('AI_PROVIDER_UNAVAILABLE');
    });
  });

  // ==================================================================
  describe('Supervisor AI assistant', () => {
    it('answers about the supervised project, never with task suggestions', async () => {
      ai.reset();
      const res = await http()
        .post(`${API}/ai-support/requests`)
        .set(as('supA'))
        .send({
          projectId: p['Smart Campus'],
          kind: 'PROJECT_QUESTION',
          question: 'How is the team progressing?',
        })
        .expect(201);
      expect(res.body.status).toBe('COMPLETED');
      // the fake answer contains a task suggestion: supervisors never receive it
      expect(res.body.guidance.taskSuggestions).toEqual([]);
      expect(ai.requests[0].system).toContain('never invent tasks');
      const denied = await http()
        .post(`${API}/ai-support/requests`)
        .set(as('supA'))
        .send({ projectId: p['Smart Campus'], kind: 'TASK_BREAKDOWN' })
        .expect(403);
      expect(denied.body.code).toBe('AI_FEATURE_NOT_FOR_SUPERVISOR');
      // a project the supervisor does not supervise
      await http()
        .post(`${API}/ai-support/requests`)
        .set(as('supA'))
        .send({
          projectId: p['Health Tracker'],
          kind: 'PROJECT_QUESTION',
          question: 'Status?',
        })
        .expect(403);
      // and supervisors cannot apply suggestions to tasks
      await http()
        .post(`${API}/projects/${p['Smart Campus']}/ai-task-suggestions/apply`)
        .set(as('supA'))
        .send({ aiRequestId: res.body.id, items: [{ suggestionId: 't1' }] })
        .expect(403);
    });
  });

  it('reference values: one vocabulary with labels and allowed transitions (public)', async () => {
    const res = await http().get(`${API}/reference/values`).expect(200);
    expect(res.body.taskStatuses).toContainEqual({
      code: 'IN_PROGRESS',
      ar: 'قيد التنفيذ',
      en: 'In progress',
    });
    expect(res.body.taskStatusTransitions.CANCELLED).toEqual(['TODO']);
    expect(res.body.documentStatuses.map((s: any) => s.code)).toEqual([
      'UPLOADED',
      'SUBMITTED',
      'UNDER_REVIEW',
      'CHANGES_REQUESTED',
      'APPROVED',
      'REJECTED',
    ]);
    expect(res.body.derived.overdue.rule).toMatch(/due date/);
    expect(JSON.stringify(res.body)).not.toMatch(/IDEA_EVALUATION|rubric/i);
  });
});
