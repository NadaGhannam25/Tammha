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
import { AuthModule } from '@modules/auth/auth.module';
import { TeamsModule } from '@modules/teams/teams.module';
import { ProjectsModule } from '@modules/projects/projects.module';
import { TasksModule } from '@modules/tasks/tasks.module';
import { DashboardModule } from '@modules/dashboard/dashboard.module';

/**
 * Complete Project Setup: the central readiness check, one requirement at a time.
 * Every case starts from a fully ready project, breaks exactly ONE condition and
 * expects exactly that code — in the readiness response AND as a 422 from completion.
 */
const API = '/api/v1';
const DAY = 24 * 60 * 60 * 1000;

describe('Project setup readiness (integration)', () => {
  let app: INestApplication;
  let db: InMemoryPrisma;
  const users: Record<string, { id: string; token: string }> = {};
  const p = { projectId: '', teamId: '', requestId: '', handbookId: '' };

  const http = () => request(app.getHttpServer());
  const as = (k: string) => ({ Authorization: `Bearer ${users[k].token}` });
  const row = (table: any, id: string) =>
    table.rows.find((r: any) => r.id === id);
  const project = () => row(db.project, p.projectId);
  const leader = () => row(db.user, users.leila.id);
  const readiness = async () =>
    (
      await http()
        .get(`${API}/projects/${p.projectId}/setup`)
        .set(as('leila'))
        .expect(200)
    ).body.readiness;

  async function seed(key: string, role: string, extra: object = {}) {
    const u = await db.user.create({
      data: {
        email: `${key}@test.local`,
        password: 'unused',
        firstName: key,
        role,
        universityId: 'uni-1',
        emailVerifiedAt: new Date(),
        ...(role === 'STUDENT' && { studentNumber: `SN-${key.toUpperCase()}` }),
        ...extra,
      },
    });
    users[key] = {
      id: u!.id,
      token: app.get(JwtService).sign({ sub: u!.id, email: u!.email, role }),
    };
  }

  beforeAll(async () => {
    db = createInMemoryPrisma();
    const moduleRef = await Test.createTestingModule({
      imports: [
        // this suite checks every requirement, including the OPTIONAL supervisor rule when it
        // is switched on; the default (supervisor optional) is covered by project-setup-optional-supervisor.integration.spec.ts
        testConfigModule({ SETUP_REQUIRE_SUPERVISOR: 'true' }),
        AuthModule,
        TeamsModule,
        ProjectsModule,
        TasksModule,
        DashboardModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(db)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    for (const s of ['leila', 'noor', 'omar']) await seed(s, 'STUDENT');
    await seed('supA', 'SUPERVISOR');
  });

  afterAll(async () => {
    await app?.close();
  });

  // ==================================================================
  describe('building a ready project', () => {
    it('a new project lists everything that is still missing', async () => {
      const res = await http()
        .post(`${API}/projects`)
        .set(as('leila'))
        .send({ name: 'Smart Clinic Queue' })
        .expect(201);
      p.projectId = res.body.project.id;
      p.teamId = res.body.team.id;
      expect(res.body.setupReadiness).toEqual({
        canComplete: false,
        completed: false,
        handbookState: 'NONE',
        handbookSource: 'UPLOAD',
        supervisorRequestStatus: null,
        missingRequirements: [
          'PROJECT_DESCRIPTION_REQUIRED',
          'PROJECT_OVERVIEW_REQUIRED',
          'PROJECT_OBJECTIVES_REQUIRED',
          'PROJECT_CATEGORY_REQUIRED',
          'PROJECT_ORIGIN_REQUIRED',
          'PROJECT_START_DATE_REQUIRED',
          'PROJECT_END_DATE_REQUIRED',
          'SUPERVISOR_REQUEST_REQUIRED',
          'HANDBOOK_REQUIRED',
        ],
      });
      const done = await http()
        .post(`${API}/projects/${p.projectId}/setup/complete`)
        .set(as('leila'))
        .expect(422);
      expect(done.body).toMatchObject({
        code: 'PROJECT_SETUP_INCOMPLETE',
        details: {
          missingRequirements: res.body.setupReadiness.missingRequirements,
        },
      });
      expect(project().setupStep).toBe('TEAM');
      expect(project().setupCompletedAt).toBeNull();
    });

    it('details, a PENDING supervisor request and a READY handbook make it ready', async () => {
      await http()
        .patch(`${API}/projects/${p.projectId}`)
        .set(as('leila'))
        .send({
          description: 'Queue management for university clinics',
          overview: 'Patients book a slot and follow the queue live.',
          objectives: ['Live queue', 'Notifications'],
          category: 'HEALTH',
          origin: 'NEW',
          startDate: '2026-09-01',
          expectedCompletionDate: '2027-05-30',
        })
        .expect(200);
      const req = await http()
        .post(`${API}/projects/${p.projectId}/supervision-requests`)
        .set(as('leila'))
        .send({ supervisorEmail: 'supA@test.local' })
        .expect(201);
      p.requestId = req.body.id;
      const handbook = await db.projectHandbook.create({
        data: {
          projectId: p.projectId,
          version: 1,
          isActive: true,
          status: 'READY',
          title: 'Clinic handbook',
          fileName: 'h.pdf',
          fileSize: 100,
          storagePath: `handbooks/projects/${p.projectId}/h.pdf`,
          extractedText: 'text',
          processingStartedAt: new Date(),
        },
      });
      p.handbookId = handbook!.id;
      // an invited student who has not answered yet must not block completion
      await http()
        .post(`${API}/teams/${p.teamId}/student-invitations`)
        .set(as('leila'))
        .send({ studentNumber: 'SN-NOOR' })
        .expect(201);
      expect(await readiness()).toEqual({
        canComplete: true,
        missingRequirements: [],
        completed: false,
        handbookState: 'READY',
        handbookSource: 'UPLOAD',
        supervisorRequestStatus: 'PENDING',
      });
    });
  });

  // ==================================================================
  describe('each requirement blocks completion on its own', () => {
    type Case = [
      string,
      () => void | Promise<void>,
      () => void | Promise<void>,
    ];
    const set = (target: () => any, field: string, value: unknown) => {
      let previous: unknown;
      return [
        () => {
          previous = target()[field];
          target()[field] = value;
        },
        () => {
          target()[field] = previous;
        },
      ] as const;
    };
    const cases: Case[] = [
      ['EMAIL_NOT_VERIFIED', ...set(leader, 'emailVerifiedAt', null)],
      ['UNIVERSITY_IDENTITY_REQUIRED', ...set(leader, 'studentNumber', null)],
      ['PROJECT_NAME_REQUIRED', ...set(project, 'name', '   ')],
      ['PROJECT_DESCRIPTION_REQUIRED', ...set(project, 'description', ' \n ')],
      ['PROJECT_DESCRIPTION_REQUIRED', ...set(project, 'description', null)],
      ['PROJECT_OVERVIEW_REQUIRED', ...set(project, 'overview', '\t')],
      ['PROJECT_OBJECTIVES_REQUIRED', ...set(project, 'objectives', [])],
      [
        'PROJECT_OBJECTIVES_REQUIRED',
        ...set(project, 'objectives', ['  ', '']),
      ],
      ['PROJECT_CATEGORY_REQUIRED', ...set(project, 'category', null)],
      ['PROJECT_CATEGORY_REQUIRED', ...set(project, 'category', 'SPACE')],
      ['PROJECT_ORIGIN_REQUIRED', ...set(project, 'origin', null)],
      ['PROJECT_ORIGIN_REQUIRED', ...set(project, 'origin', 'MAYBE')],
      ['PROJECT_START_DATE_REQUIRED', ...set(project, 'startDate', null)],
      [
        'PROJECT_END_DATE_REQUIRED',
        ...set(project, 'expectedCompletionDate', null),
      ],
      [
        'PROJECT_DATES_INVALID',
        ...set(project, 'expectedCompletionDate', new Date('2026-08-01')),
      ],
      [
        'PROJECT_DATES_INVALID',
        ...set(project, 'expectedCompletionDate', new Date('2026-09-01')),
      ],
      [
        'PROJECT_DATES_INVALID',
        ...set(project, 'endDate', new Date('2026-06-01')),
      ],
      [
        'SUPERVISOR_REQUEST_REQUIRED',
        ...set(
          () => row(db.supervisionRequest, p.requestId),
          'status',
          'REJECTED',
        ),
      ],
      [
        'SUPERVISOR_REQUEST_REQUIRED',
        ...set(
          () => row(db.supervisionRequest, p.requestId),
          'status',
          'CANCELLED',
        ),
      ],
      [
        'HANDBOOK_REQUIRED',
        () => {
          (db.projectHandbook as any).saved = db.projectHandbook.rows.splice(0);
        },
        () => {
          db.projectHandbook.rows.push(...(db.projectHandbook as any).saved);
        },
      ],
      [
        'HANDBOOK_PROCESSING',
        async () => {
          await db.projectHandbook.create({
            data: {
              projectId: p.projectId,
              version: 2,
              status: 'PROCESSING',
              title: 'New version',
              fileName: 'h2.pdf',
              fileSize: 100,
              storagePath: `handbooks/projects/${p.projectId}/h2.pdf`,
              processingStartedAt: new Date(),
            },
          });
        },
        () => {
          db.projectHandbook.rows = db.projectHandbook.rows.filter(
            (r: any) => r.version === 1,
          );
        },
      ],
      [
        'HANDBOOK_FAILED',
        () => {
          const h = row(db.projectHandbook, p.handbookId);
          h.status = 'FAILED';
          h.isActive = false;
        },
        () => {
          const h = row(db.projectHandbook, p.handbookId);
          h.status = 'READY';
          h.isActive = true;
        },
      ],
    ];

    it.each(cases.map(([code, brk, fix], i) => [i + 1, code, brk, fix]))(
      'case %i: %s',
      async (_i, code, brk, fix) => {
        await (brk as () => Promise<void>)();
        try {
          const r = await readiness();
          expect(r.canComplete).toBe(false);
          expect(r.missingRequirements).toEqual([code]);
          const res = await http()
            .post(`${API}/projects/${p.projectId}/setup/complete`)
            .set(as('leila'))
            .expect(422);
          expect(res.body).toEqual(
            expect.objectContaining({
              code: 'PROJECT_SETUP_INCOMPLETE',
              details: { missingRequirements: [code] },
            }),
          );
          expect(project().setupStep).not.toBe('COMPLETED');
        } finally {
          await (fix as () => Promise<void>)();
        }
        expect((await readiness()).canComplete).toBe(true);
      },
    );

    it('a project without a team leader cannot be completed', async () => {
      const link = db.teamMember.rows.find(
        (m: any) => m.userId === users.leila.id,
      )!;
      link.role = 'MEMBER';
      try {
        expect((await readiness()).missingRequirements).toEqual([
          'TEAM_LEADER_REQUIRED',
        ]);
        const res = await http()
          .post(`${API}/projects/${p.projectId}/setup/complete`)
          .set(as('leila'))
          .expect(403);
        expect(res.body.code).toBe('NOT_TEAM_LEADER');
      } finally {
        link.role = 'LEADER';
      }
    });

    it('several missing requirements are all reported, in setup order', async () => {
      const proj = project();
      const saved = { overview: proj.overview, startDate: proj.startDate };
      proj.overview = '';
      proj.startDate = null;
      leader().emailVerifiedAt = null;
      try {
        expect((await readiness()).missingRequirements).toEqual([
          'EMAIL_NOT_VERIFIED',
          'PROJECT_OVERVIEW_REQUIRED',
          'PROJECT_START_DATE_REQUIRED',
        ]);
      } finally {
        Object.assign(proj, saved);
        leader().emailVerifiedAt = new Date();
      }
    });
  });

  // ==================================================================
  describe('what does NOT block completion', () => {
    it('an ACCEPTED supervisor request also satisfies the supervisor step', async () => {
      await http()
        .post(`${API}/supervision-requests/${p.requestId}/accept`)
        .set(as('supA'))
        .send({})
        .expect(200);
      expect(await readiness()).toMatchObject({
        canComplete: true,
        supervisorRequestStatus: 'ACCEPTED',
      });
    });

    it('a pending team invitation and a member who never joined do not block', async () => {
      expect(
        db.teamInvitation.rows.filter((i: any) => i.status === 'PENDING'),
      ).toHaveLength(1);
      expect(
        db.teamMember.rows.filter((m: any) => m.teamId === p.teamId),
      ).toHaveLength(1);
      expect((await readiness()).canComplete).toBe(true);
    });
  });

  // ==================================================================
  describe('completion', () => {
    it('only the leader completes; the client cannot set the state itself', async () => {
      await http()
        .post(`${API}/teams/join`)
        .set(as('omar'))
        .send({
          code: db.team.rows.find((t: any) => t.id === p.teamId)!.inviteCode,
        })
        .expect(200);
      const member = await http()
        .post(`${API}/projects/${p.projectId}/setup/complete`)
        .set(as('omar'))
        .expect(403);
      expect(member.body.code).toBe('NOT_TEAM_LEADER');
      await http()
        .post(`${API}/projects/${p.projectId}/setup/complete`)
        .set(as('supA'))
        .expect(403);
      await http()
        .patch(`${API}/projects/${p.projectId}`)
        .set(as('leila'))
        .send({ setupStep: 'COMPLETED' })
        .expect(400);
      await http()
        .patch(`${API}/projects/${p.projectId}`)
        .set(as('leila'))
        .send({ setupCompletedAt: new Date().toISOString() })
        .expect(400);
      await http()
        .patch(`${API}/projects/${p.projectId}/setup`)
        .set(as('leila'))
        .send({ step: 'COMPLETED' })
        .expect(400);
      expect(project().setupCompletedAt).toBeNull();
    });

    it('concurrent completions: both succeed, one completion time; no tasks are created', async () => {
      const tasksBefore = db.task.rows.length;
      const [a, b] = await Promise.all([
        http()
          .post(`${API}/projects/${p.projectId}/setup/complete`)
          .set(as('leila')),
        http()
          .post(`${API}/projects/${p.projectId}/setup/complete`)
          .set(as('leila')),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(a.body.project.setup).toMatchObject({
        step: 'COMPLETED',
        completed: true,
      });
      expect(a.body.setupReadiness).toMatchObject({
        completed: true,
        canComplete: true,
      });
      const completedAt = project().setupCompletedAt;
      expect(completedAt).toBeInstanceOf(Date);
      expect(db.task.rows.length).toBe(tasksBefore);

      const again = await http()
        .post(`${API}/projects/${p.projectId}/setup/complete`)
        .set(as('leila'))
        .expect(200);
      expect(again.body.project.setup.completed).toBe(true);
      expect(project().setupCompletedAt).toEqual(completedAt);
    });

    it('a completed project without tasks is an EMPTY_PROJECT (AI-assisted tasks start from there)', async () => {
      const dash = await http()
        .get(`${API}/dashboard/student`)
        .set(as('omar'))
        .expect(200);
      expect(dash.body).toMatchObject({
        state: 'EMPTY_PROJECT',
        setup: { completed: true },
        handbook: { state: 'READY' },
      });
      expect(dash.body.myTasks.open).toBe(0);
    });

    it('later edits never reopen the setup', async () => {
      project().overview = '';
      const r = await readiness();
      expect(r.completed).toBe(true);
      await http()
        .post(`${API}/projects/${p.projectId}/setup/complete`)
        .set(as('leila'))
        .expect(200);
      expect(project().setupStep).toBe('COMPLETED');
      const late = (
        await http().get(`${API}/projects/${p.projectId}`).set(as('leila'))
      ).body;
      expect(late.project.setup.completed).toBe(true);
      expect(Date.now() - project().setupCompletedAt.getTime()).toBeLessThan(
        DAY,
      );
    });
  });
});
