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
import { DashboardModule } from '@modules/dashboard/dashboard.module';
import { SupabaseStorageService } from '@modules/documents/supabase-storage.service';

/**
 * HTTP integration tests for P09 dashboards and project progress/readiness.
 * Real: controllers, guards, ValidationPipe, services, workspace access, error filter.
 * Replaced: Prisma (in-memory) and Supabase Storage (fake).
 */
describe('Dashboards & project progress (integration)', () => {
  let app: INestApplication;
  let db: InMemoryPrisma;
  let jwt: JwtService;

  const API = '/api/v1';
  const DAY = 24 * 60 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;
  const users: Record<string, { id: string; token: string }> = {};
  const as = (key: string) => ({ Authorization: `Bearer ${users[key].token}` });
  const http = () => request(app.getHttpServer());
  const PDF = Buffer.from('%PDF-1.4 fake test document');
  const at = (offset: number) => new Date(Date.now() + offset);

  let projectA = '';
  let projectB = '';
  let projectC = '';
  const ids: Record<string, string> = {};

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

  async function createProject(student: string, name: string) {
    const res = await http()
      .post(`${API}/projects`)
      .set(as(student))
      .send({ name })
      .expect(201);
    return res.body as {
      project: { id: string };
      invitation: { code: string };
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

  const upload = async (
    who: string,
    projectId: string,
    title: string,
    category: string,
  ) =>
    (
      await http()
        .post(`${API}/documents/upload`)
        .set(as(who))
        .field('projectId', projectId)
        .field('title', title)
        .field('category', category)
        // these files are formal submissions (review workflow); regular uploads are UPLOADED
        .field('submitForReview', 'true')
        .attach('file', PDF, {
          filename: 'f.pdf',
          contentType: 'application/pdf',
        })
        .expect(201)
    ).body.id as string;

  const decide = (sup: string, docId: string, status: string) =>
    http()
      .patch(`${API}/documents/${docId}/submission-status`)
      .set(as(sup))
      .send({ status })
      .expect(200);

  async function task(
    projectId: string,
    title: string,
    status: string,
    due: Date | null,
    milestoneId: string | null = null,
  ) {
    const t = await db.task.create({
      data: {
        projectId,
        title,
        status,
        dueDate: due,
        milestoneId,
        createdById: users.alice.id,
      },
    });
    ids[title] = t!.id;
  }
  async function milestone(
    projectId: string,
    title: string,
    status: string,
    due: Date,
  ) {
    const m = await db.milestone.create({
      data: {
        projectId,
        title,
        status,
        dueDate: due,
        createdById: users.alice.id,
      },
    });
    ids[title] = m!.id;
    return m!.id;
  }

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
        DashboardModule,
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

    for (const s of ['alice', 'bob', 'erin', 'dave', 'carl'])
      await seedUser(s, 'STUDENT');
    for (const s of ['supA', 'supB', 'supNone'])
      await seedUser(s, 'SUPERVISOR');
    await seedUser('admin', 'ADMIN');

    // Project A (alice + bob) and Project B (erin): supervised by supA. Project C (dave): supB.
    const a = await createProject('alice', 'Project A');
    projectA = a.project.id;
    await http()
      .post(`${API}/teams/join`)
      .set(as('bob'))
      .send({ code: a.invitation.code })
      .expect(200);
    projectB = (await createProject('erin', 'Project B')).project.id;
    projectC = (await createProject('dave', 'Project C')).project.id;
    await assignSupervisor('alice', projectA, 'supA');
    await assignSupervisor('erin', projectB, 'supA');
    await assignSupervisor('dave', projectC, 'supB');

    // ---- Project A work ----
    await milestone(projectA, 'M1 done', 'COMPLETED', at(-10 * DAY));
    const m2 = await milestone(projectA, 'M2 upcoming', 'PENDING', at(5 * DAY));
    await milestone(projectA, 'M3 overdue', 'IN_PROGRESS', at(-1 * DAY - HOUR));
    await task(projectA, 'T1 done', 'COMPLETED', at(-5 * DAY), m2);
    await task(projectA, 'T2 done', 'COMPLETED', null);
    await task(projectA, 'T3 upcoming', 'TODO', at(3 * DAY), m2);
    await task(projectA, 'T4 overdue', 'IN_PROGRESS', at(-2 * DAY - HOUR));
    await task(projectA, 'T5 cancelled', 'CANCELLED', at(1 * DAY));
    await task(projectA, 'T6 far', 'TODO', at(30 * DAY));
    await task(projectA, 'T7 blocked', 'BLOCKED', null);

    ids.proposal = await upload('bob', projectA, 'Proposal', 'PROPOSAL');
    ids.report = await upload('alice', projectA, 'Report', 'REPORT');
    await decide('supA', ids.proposal, 'APPROVED');
    await decide('supA', ids.report, 'CHANGES_REQUESTED');
    // written project feedback (Tammha has no grades)
    await http()
      .post(`${API}/feedback`)
      .set(as('supA'))
      .send({
        projectId: projectA,
        comment: 'Midterm review',
      })
      .expect(201);

    // ---- Project B: one submission waiting for review ----
    ids.presentation = await upload('erin', projectB, 'Slides', 'PRESENTATION');

    // ---- Project C: supB only ----
    await task(projectC, 'C1 overdue', 'TODO', at(-3 * DAY));

    // ---- meetings (records exist) ----
    const meeting = (
      projectId: string,
      title: string,
      when: Date,
      status = 'SCHEDULED',
    ) =>
      db.meeting.create({
        data: {
          projectId,
          title,
          scheduledAt: when,
          duration: 30,
          status,
          createdById: users.supA.id,
        },
      });
    await meeting(projectA, 'Weekly sync', at(2 * DAY));
    await meeting(projectA, 'Past meeting', at(-2 * DAY), 'COMPLETED');
    await meeting(projectA, 'Cancelled', at(1 * DAY), 'CANCELLED');
    await meeting(projectA, 'Far future', at(40 * DAY));
    await meeting(projectC, 'Other project', at(1 * DAY));

    // alice read one notification
    const first = db.notification.rows.find(
      (n: any) => n.userId === users.alice.id,
    );
    first!.isRead = true;
  });

  afterAll(async () => {
    await app?.close();
  });

  // ==================================================================
  describe('JWT, roles and Swagger', () => {
    it.each([
      ['/dashboard/student'],
      ['/dashboard/supervisor'],
      ['/projects/x/progress'],
      ['/projects/x/readiness'],
    ])('GET %s -> 401 without token', async (path) => {
      await http().get(`${API}${path}`).expect(401);
    });

    it('each dashboard is for its own role; ADMIN gets neither', async () => {
      await http().get(`${API}/dashboard/student`).set(as('supA')).expect(403);
      await http()
        .get(`${API}/dashboard/supervisor`)
        .set(as('alice'))
        .expect(403);
      await http().get(`${API}/dashboard/student`).set(as('admin')).expect(403);
      await http()
        .get(`${API}/dashboard/supervisor`)
        .set(as('admin'))
        .expect(403);
    });

    it('query validation', async () => {
      for (const q of [
        'days=0',
        'days=91',
        'days=abc',
        'limit=0',
        'limit=21',
        'extra=1',
      ]) {
        await http()
          .get(`${API}/dashboard/student?${q}`)
          .set(as('alice'))
          .expect(400);
      }
    });

    it('Swagger documents the routes and response schemas', () => {
      const doc = createSwaggerDocument(app);
      expect(Object.keys(doc.paths)).toEqual(
        expect.arrayContaining([
          `${API}/dashboard/student`,
          `${API}/dashboard/supervisor`,
          `${API}/projects/{id}/progress`,
          `${API}/projects/{id}/readiness`,
        ]),
      );
      const schemas = Object.keys(doc.components?.schemas ?? {});
      expect(schemas).toEqual(
        expect.arrayContaining([
          'StudentDashboardDto',
          'SupervisorDashboardDto',
          'ReadinessDto',
          'ProgressDto',
        ]),
      );
    });
  });

  // ==================================================================
  describe('Student dashboard', () => {
    let body: any;
    beforeAll(async () => {
      body = (
        await http().get(`${API}/dashboard/student`).set(as('bob')).expect(200)
      ).body;
    });

    it('project information with team and supervisor (no passwords)', () => {
      expect(body.hasProject).toBe(true);
      expect(body.project).toMatchObject({
        id: projectA,
        name: 'Project A',
        status: 'PLANNING',
      });
      expect(body.project.members).toHaveLength(2);
      expect(body.project.supervisor).toMatchObject({ id: users.supA.id });
      expect(JSON.stringify(body)).not.toContain('password');
    });

    it('task counts: total/completed/pending/overdue (cancelled excluded)', () => {
      expect(body.tasks).toMatchObject({
        total: 6,
        completed: 2,
        pending: 4,
        overdue: 1,
        cancelled: 1,
        completionPercent: 33,
      });
      expect(body.tasks.byStatus).toMatchObject({
        COMPLETED: 2,
        TODO: 2,
        CANCELLED: 1,
      });
    });

    it('milestones with their own task progress, by due date', () => {
      expect(body.milestones).toMatchObject({
        total: 3,
        completed: 1,
        pending: 2,
        overdue: 1,
      });
      expect(body.milestones.items.map((m: any) => m.title)).toEqual([
        'M1 done',
        'M3 overdue',
        'M2 upcoming',
      ]);
      const m2 = body.milestones.items.find(
        (m: any) => m.title === 'M2 upcoming',
      );
      expect(m2).toMatchObject({
        totalTasks: 2,
        completedTasks: 1,
        percent: 50,
        isOverdue: false,
      });
      expect(body.milestones.items[1].isOverdue).toBe(true);
    });

    it('upcoming deadlines: open tasks and milestones inside the window, soonest first', () => {
      expect(
        body.upcomingDeadlines.map((d: any) => [d.type, d.title, d.daysLeft]),
      ).toEqual([
        ['TASK', 'T3 upcoming', 2],
        ['MILESTONE', 'M2 upcoming', 4],
      ]);
    });

    it('a wider window includes later deadlines', async () => {
      const res = await http()
        .get(`${API}/dashboard/student?days=31`)
        .set(as('bob'))
        .expect(200);
      expect(res.body.upcomingDeadlines.map((d: any) => d.title)).toContain(
        'T6 far',
      );
    });

    it('latest documents and submission status summary', () => {
      expect(body.latestDocuments.map((d: any) => d.title).sort()).toEqual([
        'Proposal',
        'Report',
      ]);
      expect(body.latestDocuments[0]).toHaveProperty('reviewStatus');
      expect(body.latestDocuments[0].versions).toBe(1);
      expect(body.submissions).toMatchObject({
        total: 2,
        awaitingReview: 0,
        needsChanges: 1,
        approved: 1,
      });
      expect(body.submissions.requiredDocuments).toEqual([
        { category: 'PROPOSAL', status: 'APPROVED', documentCount: 1 },
        { category: 'REPORT', status: 'CHANGES_REQUESTED', documentCount: 1 },
        { category: 'PRESENTATION', status: 'MISSING', documentCount: 0 },
      ]);
    });

    it('latest feedback: newest first, written feedback only (no grades)', () => {
      expect(body.latestFeedback[0]).toMatchObject({
        comment: 'Midterm review',
      });
      for (const key of [
        'score',
        'maxScore',
        'rubric',
        'scoreVisibleToStudents',
      ]) {
        expect(body.latestFeedback[0]).not.toHaveProperty(key);
      }
      expect(body.latestFeedback.map((f: any) => f.status)).toEqual([
        null,
        'CHANGES_REQUESTED',
        'APPROVED',
      ]);
    });

    it('upcoming meetings: scheduled, in the window, own project only', () => {
      expect(body.upcomingMeetings.map((m: any) => m.title)).toEqual([
        'Weekly sync',
      ]);
    });

    it('unread notification count', async () => {
      const unread = (key: string) =>
        db.notification.rows.filter(
          (n: any) => n.userId === users[key].id && !n.isRead,
        ).length;
      expect(body.unreadNotifications).toBe(unread('bob'));
      expect(body.unreadNotifications).toBeGreaterThan(0);
      const alice = await http()
        .get(`${API}/dashboard/student`)
        .set(as('alice'))
        .expect(200);
      expect(alice.body.unreadNotifications).toBe(unread('alice'));
      expect(alice.body.unreadNotifications).toBe(body.unreadNotifications - 1);
    });

    it('progress and readiness are the deterministic rule results', () => {
      // tasks 2/6 * 50 + milestones 1/3 * 30 + approved required 1/3 * 20 = 33.3
      expect(body.completionPercent).toBe(33);
      expect(body.progress.percent).toBe(33);
      // 8.33 + 6.67 + 10 + 8.33 + 5 + 0 = 38.3
      expect(body.readiness).toMatchObject({
        score: 38,
        level: 'NOT_READY',
        aiUsed: false,
        method: 'RULE_BASED',
      });
      expect(body.readiness.missing).toEqual([
        'Complete 4 remaining tasks',
        'Complete 2 remaining milestones',
        'Upload: PRESENTATION',
        'Get supervisor approval for: REPORT, PRESENTATION',
        'Upload a new version of 1 document with requested changes',
        'Finish or reschedule the overdue items',
      ]);
    });

    it('limit applies to the lists', async () => {
      const res = await http()
        .get(`${API}/dashboard/student?limit=1`)
        .set(as('bob'))
        .expect(200);
      expect(res.body.latestDocuments).toHaveLength(1);
      expect(res.body.latestFeedback).toHaveLength(1);
      expect(res.body.upcomingDeadlines).toHaveLength(1);
    });

    it('a student without a team gets an empty dashboard, not an error', async () => {
      const res = await http()
        .get(`${API}/dashboard/student`)
        .set(as('carl'))
        .expect(200);
      expect(res.body).toMatchObject({
        hasProject: false,
        project: null,
        completionPercent: 0,
        tasks: null,
        progress: null,
        readiness: null,
        upcomingDeadlines: [],
        latestFeedback: [],
        unreadNotifications: 0,
      });
    });

    it('a new version resets the change request and readiness improves', async () => {
      await http()
        .post(`${API}/documents/${ids.report}/versions`)
        .set(as('alice'))
        .attach('file', PDF, {
          filename: 'f2.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);
      const res = await http()
        .get(`${API}/projects/${projectA}/readiness`)
        .set(as('alice'))
        .expect(200);
      const c = res.body.criteria.find(
        (x: any) => x.key === 'FEEDBACK_ADDRESSED',
      );
      expect(c).toMatchObject({ met: true, points: 10 });
      expect(res.body.score).toBe(43);
    });
  });

  // ==================================================================
  describe('Project progress / readiness endpoints', () => {
    it('students of the project and its supervisor can read them', async () => {
      const res = await http()
        .get(`${API}/projects/${projectA}/progress`)
        .set(as('alice'))
        .expect(200);
      expect(res.body).toMatchObject({ projectId: projectA });
      expect(res.body.progress.components).toHaveLength(3);
      expect(res.body.readiness.criteria).toHaveLength(6);
      const sup = await http()
        .get(`${API}/projects/${projectA}/progress`)
        .set(as('supA'))
        .expect(200);
      expect(sup.body.progress).toEqual(res.body.progress);
    });

    it('everyone else gets 403/404', async () => {
      for (const who of ['erin', 'supB', 'supNone', 'admin']) {
        await http()
          .get(`${API}/projects/${projectA}/progress`)
          .set(as(who))
          .expect(403);
      }
      const res = await http()
        .get(`${API}/projects/${projectA}/readiness`)
        .set(as('erin'))
        .expect(403);
      expect(res.body.code).toBe('PROJECT_ACCESS_DENIED');
      const missing = await http()
        .get(`${API}/projects/nope/progress`)
        .set(as('supA'))
        .expect(404);
      expect(missing.body.code).toBe('PROJECT_NOT_FOUND');
    });
  });

  // ==================================================================
  describe('Supervisor dashboard', () => {
    let body: any;
    beforeAll(async () => {
      body = (
        await http()
          .get(`${API}/dashboard/supervisor?days=14`)
          .set(as('supA'))
          .expect(200)
      ).body;
    });

    it('supervised projects only, with team progress', () => {
      expect(body.projects.map((p: any) => p.name)).toEqual([
        'Project A',
        'Project B',
      ]);
      const a = body.projects[0];
      expect(a).toMatchObject({
        id: projectA,
        memberCount: 2,
        tasks: { total: 6, completed: 2, pending: 4, overdue: 1 },
        milestones: { total: 3, completed: 1, pending: 2, overdue: 1 },
        hasOverdue: true,
        needsChanges: 0,
        awaitingReview: 1, // the report's new version is SUBMITTED again
      });
      expect(a.progressPercent).toBe(33);
      expect(a.readinessScore).toBe(43);
      expect(body.projects[1]).toMatchObject({
        id: projectB,
        memberCount: 1,
        hasOverdue: false,
      });
    });

    it('summary totals', () => {
      expect(body.summary).toMatchObject({
        totalProjects: 2,
        projectsWithOverdue: 1,
        overdueTasks: 1,
        overdueMilestones: 1,
        awaitingReview: 2,
        needsChanges: 0,
        readyProjects: 0,
      });
      expect(body.summary.unreadNotifications).toBeGreaterThan(0);
    });

    it('overdue projects and tasks (most overdue first, with project name)', () => {
      expect(body.overdue.projects).toEqual([
        {
          id: projectA,
          name: 'Project A',
          overdueTasks: 1,
          overdueMilestones: 1,
        },
      ]);
      expect(body.overdue.tasks).toHaveLength(1);
      expect(body.overdue.tasks[0]).toMatchObject({
        title: 'T4 overdue',
        projectName: 'Project A',
        daysOverdue: 2,
      });
      expect(body.overdue.totalOverdueTasks).toBe(1);
    });

    it('latest submissions: uploads and new versions, newest first', () => {
      expect(
        body.latestSubmissions.map((s: any) => [s.title, s.version]),
      ).toEqual([
        ['Report', 2],
        ['Slides', 1],
        ['Report', 1],
        ['Proposal', 1],
      ]);
      expect(body.latestSubmissions[1]).toMatchObject({
        projectName: 'Project B',
        reviewStatus: 'SUBMITTED',
      });
    });

    it('items awaiting review: longest waiting first', () => {
      expect(body.awaitingReview.total).toBe(2);
      expect(body.awaitingReview.items.map((i: any) => i.title)).toEqual([
        'Slides',
        'Report',
      ]);
    });

    it('upcoming meetings of supervised projects only', () => {
      expect(body.upcomingMeetings.map((m: any) => m.title)).toEqual([
        'Weekly sync',
      ]);
    });

    it('another supervisor sees only their projects', async () => {
      const res = await http()
        .get(`${API}/dashboard/supervisor`)
        .set(as('supB'))
        .expect(200);
      expect(res.body.projects.map((p: any) => p.id)).toEqual([projectC]);
      expect(res.body.overdue.tasks.map((t: any) => t.title)).toEqual([
        'C1 overdue',
      ]);
      expect(res.body.upcomingMeetings.map((m: any) => m.title)).toEqual([
        'Other project',
      ]);
      expect(res.body.latestSubmissions).toEqual([]);
    });

    it('a supervisor without projects gets an empty dashboard', async () => {
      const res = await http()
        .get(`${API}/dashboard/supervisor`)
        .set(as('supNone'))
        .expect(200);
      expect(res.body.summary.totalProjects).toBe(0);
      expect(res.body.projects).toEqual([]);
    });
  });

  // ==================================================================
  describe('Query count does not grow with the number of projects (no N+1)', () => {
    const READS = ['findUnique', 'findFirst', 'findMany', 'count', 'groupBy'];
    let calls = 0;

    beforeAll(() => {
      for (const table of Object.values(db) as any[]) {
        if (!table || typeof table !== 'object' || !table.rows) continue;
        for (const method of READS) {
          const original = table[method].bind(table);
          table[method] = (...args: unknown[]) => {
            calls++;
            return original(...args);
          };
        }
      }
    });

    const countCalls = async (path: string, who: string) => {
      calls = 0;
      await http().get(`${API}${path}`).set(as(who)).expect(200);
      return calls;
    };

    it('supervisor dashboard: same number of queries for 2 and 6 projects', async () => {
      const before = await countCalls('/dashboard/supervisor', 'supA');

      // 4 more supervised projects, each with tasks, milestones and documents
      for (let i = 0; i < 4; i++) {
        const team = await db.team.create({
          data: { name: `Extra team ${i}` },
        });
        const p = await db.project.create({
          data: { name: `Extra ${i}`, teamId: team!.id },
        });
        await db.projectMember.create({
          data: { userId: users.supA.id, projectId: p!.id },
        });
        for (let t = 0; t < 3; t++)
          await task(
            p!.id,
            `Extra ${i}-${t}`,
            t ? 'TODO' : 'COMPLETED',
            at(-DAY),
          );
        await milestone(p!.id, `Extra M ${i}`, 'PENDING', at(DAY));
        const d = await db.document.create({
          data: {
            projectId: p!.id,
            title: `Doc ${i}`,
            uploadedById: users.alice.id,
            fileUrl: 'x',
            fileType: 'application/pdf',
            fileSize: 1,
          },
        });
        await db.documentVersion.create({
          data: { documentId: d!.id, version: 1, fileUrl: 'x' },
        });
      }

      const after = await countCalls('/dashboard/supervisor', 'supA');
      const res = await http()
        .get(`${API}/dashboard/supervisor`)
        .set(as('supA'))
        .expect(200);
      expect(res.body.summary.totalProjects).toBe(6);
      expect(after).toBe(before);
    });

    it('student dashboard: same number of queries with more tasks and documents', async () => {
      const before = await countCalls('/dashboard/student', 'erin');
      for (let t = 0; t < 10; t++)
        await task(projectB, `B${t}`, 'TODO', at(DAY));
      await upload('erin', projectB, 'Extra', 'REPORT');
      const after = await countCalls('/dashboard/student', 'erin');
      expect(after).toBe(before);
    });
  });
});
