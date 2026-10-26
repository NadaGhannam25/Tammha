import './e2e-preflight'; // must be first: loads .env and refuses fake/missing DATABASE_URL
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { configureApp, createSwaggerDocument } from '@/app.setup';
import { PrismaService } from '@/prisma/prisma.service';
import { ReadOnlyPrismaService } from './read-only-prisma';
import { ProjectMetricsService } from '@modules/dashboard/progress/project-metrics.service';

/**
 * REAL-DATABASE smoke test (Supabase): `npm run test:e2e`
 *
 * SAFETY
 * - READ-ONLY and enforced: PrismaService is replaced by ReadOnlyPrismaService, which
 *   rejects every write before it reaches the database. The last test fails if any
 *   write was even attempted.
 * - No reset, no migration, no table changes, no test data created or deleted.
 * - Requests that could write (e.g. a valid registration) are never sent.
 */
const API = '/api/v1';

/** Migrations that must already be applied to the real database. */
const EXPECTED_MIGRATIONS = [
  '20260927211551_initial_mpp_schema',
  '20261012034000_p04_p06_workspace_tasks_milestones',
  '20261016090000_p08_feedback_submission_status',
  '20261018120000_p11_notifications_reminders_email',
  '20261022120000_p12_meetings_livekit',
  '20261023120000_p13_ai_support_handbooks',
];
/** Created with: npx prisma migrate dev --create-only --name p08_feedback_submission_status */
const P08_MIGRATION_SUFFIX = 'p08_feedback_submission_status';

describe('Tammha Backend - real database smoke test (read-only)', () => {
  let app: INestApplication;
  let prisma: ReadOnlyPrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useClass(ReadOnlyPrismaService)
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init(); // connects to the database (PrismaService.onModuleInit)
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app?.close();
  });

  const http = () => request(app.getHttpServer());

  describe('application and database', () => {
    it('the application starts and connects with the read-only guard active', () => {
      expect(prisma).toBeInstanceOf(ReadOnlyPrismaService);
    });

    it('GET /health reports a connected database', async () => {
      const res = await http().get(`${API}/health`).expect(200);
      expect(res.body).toMatchObject({ status: 'ok', database: 'connected' });
    });

    it('P14: security headers are sent and the framework is hidden', async () => {
      const res = await http().get(`${API}/health`).expect(200);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toContain(
        "default-src 'none'",
      );
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('Prisma queries the real database', async () => {
      const rows = await prisma.$queryRaw<
        { ok: number }[]
      >`SELECT 1::int AS ok`;
      expect(rows).toEqual([{ ok: 1 }]);
    });

    it('the expected migrations are applied and finished (migration table is only read)', async () => {
      const rows = await prisma.$queryRaw<{ migration_name: string }[]>`
        SELECT migration_name FROM _prisma_migrations
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
      const applied = rows.map((r) => r.migration_name);
      for (const name of EXPECTED_MIGRATIONS) expect(applied).toContain(name);
      // P08: generated locally, so only the name suffix is known in advance
      expect(applied.some((n) => n.endsWith(`_${P08_MIGRATION_SUFFIX}`))).toBe(
        true,
      );
    });

    it('P08 columns exist (run the P08 migration first if this fails)', async () => {
      await prisma.document.findFirst({
        select: { id: true, reviewStatus: true, reviewStatusUpdatedAt: true },
      });
      await prisma.feedback.findFirst({
        select: {
          id: true,
          documentId: true,
          documentVersion: true,
          status: true,
          score: true,
          maxScore: true,
          rubric: true,
          scoreVisibleToStudents: true,
          updatedAt: true,
        },
      });
      expect(await prisma.notification.count()).toEqual(expect.any(Number));
    });

    it('P11 notification columns and the email log exist (run the P11 migration first if this fails)', async () => {
      await prisma.notification.findFirst({
        select: { id: true, dedupeKey: true, readAt: true },
      });
      expect(await prisma.emailDelivery.count()).toEqual(expect.any(Number));
      // the reminder query shape (open tasks by due date) runs on PostgreSQL
      await prisma.task.findMany({
        where: {
          status: { in: ['TODO', 'IN_PROGRESS'] },
          dueDate: { lt: new Date() },
        },
        select: { id: true, project: { select: { teamId: true } } },
        take: 1,
      });
    });

    it('P12 meeting columns exist (run the P12 migration first if this fails)', async () => {
      await prisma.meeting.findFirst({
        select: {
          id: true,
          liveKitRoomName: true,
          cancelledAt: true,
          cancellationReason: true,
          attendees: { select: { userId: true, joinedAt: true }, take: 1 },
        },
      });
      // the "my meetings" filter shape runs on PostgreSQL
      await prisma.meeting.count({
        where: { attendees: { some: { userId: 'e2e-no-such-user' } } },
      });
    });

    it('P13 AI request metadata and handbook columns exist (run the P13 migration first if this fails)', async () => {
      await prisma.aISupport.findFirst({
        select: {
          id: true,
          kind: true,
          provider: true,
          model: true,
          result: true,
          errorCode: true,
          latencyMs: true,
          inputTokens: true,
          outputTokens: true,
          handbookId: true,
          handbookExcerpts: true,
          completedAt: true,
        },
      });
      await prisma.universityHandbook.findFirst({
        select: {
          id: true,
          pageCount: true,
          extractedChars: true,
          uploadedById: true,
          contentType: true,
        },
      });
      // the rate-limit query shape runs on PostgreSQL
      await prisma.aISupport.count({
        where: {
          userId: 'e2e-no-such-user',
          createdAt: { gte: new Date(Date.now() - 3600_000) },
        },
      });
    });

    it('P09 dashboard aggregates run on the real database (grouped reads only)', async () => {
      // Real project ids (if any) plus one id that does not exist, so the grouped
      // queries always reach PostgreSQL. Nothing is written.
      const projects = await prisma.project.findMany({
        select: { id: true },
        take: 5,
      });
      const ids = [...projects.map((p) => p.id), 'e2e-no-such-project'];
      const metrics = await app.get(ProjectMetricsService).loadMetrics(ids);
      expect(metrics.size).toBe(ids.length);
      for (const m of metrics.values()) {
        expect(m.progress.percent).toBeGreaterThanOrEqual(0);
        expect(m.progress.percent).toBeLessThanOrEqual(100);
        expect(m.readiness.aiUsed).toBe(false);
      }
      const meetings = await prisma.meeting.count();
      expect(meetings).toEqual(expect.any(Number));
    });

    it('P03-P06 tables and columns exist (read-only queries)', async () => {
      // Each query fails if its table or selected column is missing from the real schema.
      expect(await prisma.user.count()).toEqual(expect.any(Number));
      expect(await prisma.refreshToken.count()).toEqual(expect.any(Number));
      await prisma.team.findFirst({
        select: { id: true, inviteCode: true, inviteCodeUpdatedAt: true },
      });
      expect(await prisma.supervisionRequest.count()).toEqual(
        expect.any(Number),
      );
      expect(await prisma.milestone.count()).toEqual(expect.any(Number));
      await prisma.task.findFirst({
        select: { id: true, status: true, dueDate: true, completedAt: true },
      });
    });
  });

  describe('public endpoints', () => {
    it('GET /universities returns the active universities stored in the database', async () => {
      const res = await http().get(`${API}/universities`).expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(
        await prisma.university.count({ where: { isActive: true } }),
      );
      for (const u of res.body)
        expect(Object.keys(u).sort()).toEqual(['code', 'id', 'name']);
    });

    it('login with an unknown email is rejected (read-only path)', async () => {
      const email = `e2e-nobody-${Date.now()}@example.invalid`;
      const res = await http()
        .post(`${API}/auth/login`)
        .send({ email, password: 'NotARealPassword1' })
        .expect(401);
      expect(res.body.message).toBe('Invalid email or password');
    });

    it('an unknown refresh token is rejected (read-only path)', async () => {
      await http()
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: 'f'.repeat(64) })
        .expect(401);
    });

    it('validation errors use the standard error shape (no database call)', async () => {
      const res = await http().post(`${API}/auth/login`).send({}).expect(400);
      expect(res.body).toMatchObject({
        statusCode: 400,
        path: `${API}/auth/login`,
      });
      expect(Array.isArray(res.body.message)).toBe(true);
    });
  });

  describe('authentication protection', () => {
    it.each([
      ['get', '/auth/me'],
      ['post', '/auth/logout'],
      ['get', '/projects/me'],
      ['get', '/teams/me'],
      ['get', '/tasks'],
      ['get', '/tasks/overdue'],
      ['get', '/milestones'],
      ['get', '/supervision-requests/incoming'],
      ['get', '/documents'],
      ['post', '/documents/upload'],
      ['get', '/feedback'],
      ['post', '/feedback'],
      ['patch', '/feedback/x'],
      ['patch', '/documents/x/submission-status'],
      ['get', '/dashboard/student'],
      ['get', '/dashboard/supervisor'],
      ['get', '/projects/x/progress'],
      ['get', '/projects/x/readiness'],
      ['get', '/integrations/status'],
      ['get', '/notifications'],
      ['get', '/notifications/unread'],
      ['get', '/notifications/unread-count'],
      ['patch', '/notifications/x/read'],
      ['patch', '/notifications/read-all'],
      ['patch', '/projects/x/status'],
      ['post', '/meetings'],
      ['get', '/meetings'],
      ['get', '/meetings/upcoming'],
      ['get', '/meetings/x'],
      ['patch', '/meetings/x'],
      ['post', '/meetings/x/cancel'],
      ['post', '/meetings/x/token'],
      ['post', '/ai-support/requests'],
      ['get', '/ai-support/requests'],
      ['get', '/ai-support/limits?projectId=x'],
      ['get', '/ai-support/handbook?projectId=x'],
      ['get', '/admin/handbooks'],
      ['put', '/admin/universities/x/handbook'],
    ])('%s %s requires a JWT', async (method, path) => {
      await (http() as any)[method](`${API}${path}`).expect(401);
    });

    it('rejects a malformed / forged token', async () => {
      await http()
        .get(`${API}/auth/me`)
        .set(
          'Authorization',
          'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.forged',
        )
        .expect(401);
    });

    it('P14: a token signed with the real secret but without issuer/audience is rejected', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const jsonwebtoken = require('jsonwebtoken');
      const token = jsonwebtoken.sign(
        { sub: 'not-a-user', role: 'ADMIN' },
        process.env.JWT_SECRET,
        { algorithm: 'HS256', expiresIn: 60 },
      );
      await http()
        .get(`${API}/auth/me`)
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });
  });

  describe('Swagger', () => {
    it('the OpenAPI document builds with all P03-P13 routes', () => {
      const paths = Object.keys(createSwaggerDocument(app).paths);
      for (const p of [
        '/auth/login',
        '/projects',
        '/teams/join',
        '/tasks',
        '/milestones',
        '/documents',
        '/documents/upload',
        '/feedback',
        '/feedback/{id}',
        '/documents/{id}/submission-status',
        '/dashboard/student',
        '/dashboard/supervisor',
        '/projects/{id}/progress',
        '/projects/{id}/readiness',
        '/integrations/status',
        '/notifications',
        '/notifications/{id}/read',
        '/notifications/read-all',
        '/projects/{id}/status',
        '/meetings',
        '/meetings/upcoming',
        '/meetings/{id}',
        '/meetings/{id}/cancel',
        '/meetings/{id}/token',
        '/ai-support/requests',
        '/ai-support/requests/{id}',
        '/ai-support/limits',
        '/ai-support/handbook',
        '/ai-support/features',
        '/admin/handbooks',
        '/admin/universities/{universityId}/handbook',
      ]) {
        expect(paths).toContain(`${API}${p}`);
      }
    });
  });

  describe('safety', () => {
    it('the read-only guard blocks writes before they reach the database', async () => {
      const before = prisma.blockedWrites.length;
      // Even if the guard failed, this matches no row (impossible id) and changes nothing.
      await expect(
        prisma.university.updateMany({
          where: { id: '__e2e_guard_check_no_such_id__' },
          data: { name: '__never__' },
        }),
      ).rejects.toThrow('E2E suite is read-only');
      expect(prisma.blockedWrites.slice(before)).toEqual([
        'University.updateMany',
      ]);
      prisma.blockedWrites.length = before; // this one was intentional
    });

    it('no write was attempted during the whole suite', () => {
      expect(prisma.blockedWrites).toEqual([]);
    });
  });
});
