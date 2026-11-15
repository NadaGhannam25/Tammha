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
import { FakeEmailSender } from '@/testing/fake-email-sender';
import { AuthModule } from '@modules/auth/auth.module';
import { ProjectsModule } from '@modules/projects/projects.module';
import { TeamsModule } from '@modules/teams/teams.module';
import { DocumentsModule } from '@modules/documents/documents.module';
import { FeedbackModule } from '@modules/feedback/feedback.module';
import { NotificationsModule } from '@modules/notifications/notifications.module';
import { SupabaseStorageService } from '@modules/documents/supabase-storage.service';
import { IntegrationsModule } from '@/integrations/integrations.module';
import { EMAIL_SENDER } from '@/integrations/email/email.sender';
import { NotificationsService } from '../notifications.service';
import { TaskRemindersService } from '../reminders/task-reminders.service';
import { EmailOutboxService } from '../email/email-outbox.service';
import { MeetingNotificationsService } from '../meeting-notifications.service';

/**
 * P11 integration tests: in-app notification APIs, ownership, event notifications,
 * deadline reminders, duplicate prevention and the email outbox.
 * Real: controllers, guards, validation, services. Replaced: Prisma (in-memory),
 * Supabase Storage and the email provider (FakeEmailSender — nothing leaves the process).
 */
describe('Notifications, reminders & email (integration)', () => {
  let app: INestApplication;
  let db: InMemoryPrisma;
  let jwt: JwtService;
  let mail: FakeEmailSender;
  let notifications: NotificationsService;
  let reminders: TaskRemindersService;
  let outbox: EmailOutboxService;
  let meetings: MeetingNotificationsService;
  let flush: jest.SpyInstance;

  const API = '/api/v1';
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const users: Record<string, { id: string; token: string }> = {};
  const as = (key: string) => ({ Authorization: `Bearer ${users[key].token}` });
  const http = () => request(app.getHttpServer());
  const PDF = Buffer.from('%PDF-1.4 fake');
  let projectA = '';

  const rowsOf = (key: string) =>
    db.notification.rows.filter((n: any) => n.userId === users[key].id);
  const mailsOf = (key: string) =>
    db.emailDelivery.rows.filter((m: any) => m.userId === users[key].id);
  const clearAll = () => {
    db.notification.rows.length = 0;
    db.emailDelivery.rows.length = 0;
    mail.reset();
  };

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

  beforeAll(async () => {
    db = createInMemoryPrisma();
    mail = new FakeEmailSender();
    const moduleRef = await Test.createTestingModule({
      imports: [
        testConfigModule(),
        IntegrationsModule,
        AuthModule,
        TeamsModule,
        ProjectsModule,
        DocumentsModule,
        FeedbackModule,
        NotificationsModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(db)
      .overrideProvider(SupabaseStorageService)
      .useValue(new FakeStorageService())
      .overrideProvider(EMAIL_SENDER)
      .useValue(mail)
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    jwt = app.get(JwtService);
    notifications = app.get(NotificationsService);
    reminders = app.get(TaskRemindersService);
    outbox = app.get(EmailOutboxService);
    meetings = app.get(MeetingNotificationsService);
    // Tests drive dispatch() with explicit clocks; the automatic "send soon" timer is
    // verified separately (it would otherwise fire with the real clock mid-test).
    flush = jest
      .spyOn(outbox, 'requestFlush')
      .mockImplementation(() => undefined);

    for (const s of ['alice', 'bob', 'erin']) await seedUser(s, 'STUDENT');
    for (const s of ['supA', 'supB']) await seedUser(s, 'SUPERVISOR');
    await seedUser('admin', 'ADMIN');

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
    await http()
      .post(`${API}/projects`)
      .set(as('erin'))
      .send({ name: 'Project B' })
      .expect(201);
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

  // ==================================================================
  describe('In-app API: JWT, ownership, Swagger', () => {
    beforeAll(async () => {
      clearAll();
      for (let i = 1; i <= 3; i++) {
        await notifications.notify([users.alice.id], {
          type: 'SYSTEM_ALERT',
          title: `Alice ${i}`,
          message: `m${i}`,
        });
      }
      await notifications.notify([users.bob.id], {
        type: 'TASK_OVERDUE',
        title: 'Bob only',
        message: 'private to bob',
      });
    });

    it.each([
      ['get', '/notifications'],
      ['get', '/notifications/unread'],
      ['get', '/notifications/unread-count'],
      ['patch', '/notifications/x/read'],
      ['patch', '/notifications/read-all'],
    ])('%s %s -> 401 without token', async (method, path) => {
      await (http() as any)[method](`${API}${path}`).expect(401);
    });

    it('lists only my notifications, newest first, with unreadCount', async () => {
      const res = await http()
        .get(`${API}/notifications`)
        .set(as('alice'))
        .expect(200);
      expect(res.body.items.map((n: any) => n.title)).toEqual([
        'Alice 3',
        'Alice 2',
        'Alice 1',
      ]);
      expect(res.body.unreadCount).toBe(3);
      expect(res.body.meta).toMatchObject({ total: 3, page: 1 });
      expect(JSON.stringify(res.body)).not.toContain('private to bob');
      expect(res.body.items[0]).not.toHaveProperty('dedupeKey');
      expect(res.body.items[0]).not.toHaveProperty('userId');
    });

    it('filters, pagination and validation', async () => {
      const page = await http()
        .get(`${API}/notifications?limit=2&page=2`)
        .set(as('alice'))
        .expect(200);
      expect(page.body.items.map((n: any) => n.title)).toEqual(['Alice 1']);
      const bob = await http()
        .get(`${API}/notifications?type=TASK_OVERDUE`)
        .set(as('bob'))
        .expect(200);
      expect(bob.body.items).toHaveLength(1);
      await http()
        .get(`${API}/notifications?isRead=maybe`)
        .set(as('alice'))
        .expect(400);
      await http()
        .get(`${API}/notifications?type=NOPE`)
        .set(as('alice'))
        .expect(400);
      await http()
        .get(`${API}/notifications?limit=1000`)
        .set(as('alice'))
        .expect(400);
    });

    it('mark one as read: own only, idempotent, others get 404', async () => {
      const id = rowsOf('alice').find((n: any) => n.title === 'Alice 2')!.id;
      const bobsId = rowsOf('bob')[0].id;

      const first = await http()
        .patch(`${API}/notifications/${id}/read`)
        .set(as('alice'))
        .expect(200);
      expect(first.body).toMatchObject({ id, isRead: true });
      expect(first.body.readAt).toBeTruthy();
      const again = await http()
        .patch(`${API}/notifications/${id}/read`)
        .set(as('alice'))
        .expect(200);
      expect(again.body.readAt).toBe(first.body.readAt);

      const other = await http()
        .patch(`${API}/notifications/${bobsId}/read`)
        .set(as('alice'))
        .expect(404);
      expect(other.body.code).toBe('NOTIFICATION_NOT_FOUND');
      expect(rowsOf('bob')[0].isRead).toBe(false);
      await http()
        .patch(`${API}/notifications/nope/read`)
        .set(as('alice'))
        .expect(404);
    });

    it('unread list and unread count', async () => {
      const unread = await http()
        .get(`${API}/notifications/unread`)
        .set(as('alice'))
        .expect(200);
      expect(unread.body.items.map((n: any) => n.title)).toEqual([
        'Alice 3',
        'Alice 1',
      ]);
      const count = await http()
        .get(`${API}/notifications/unread-count`)
        .set(as('alice'))
        .expect(200);
      expect(count.body).toEqual({ unreadCount: 2 });
      const read = await http()
        .get(`${API}/notifications?isRead=true`)
        .set(as('alice'))
        .expect(200);
      expect(read.body.items.map((n: any) => n.title)).toEqual(['Alice 2']);
    });

    it('mark all as read touches only my notifications', async () => {
      const res = await http()
        .patch(`${API}/notifications/read-all`)
        .set(as('alice'))
        .expect(200);
      expect(res.body).toEqual({ updated: 2 });
      expect(rowsOf('alice').every((n: any) => n.isRead && n.readAt)).toBe(
        true,
      );
      expect(rowsOf('bob')[0].isRead).toBe(false);
      const again = await http()
        .patch(`${API}/notifications/read-all`)
        .set(as('alice'))
        .expect(200);
      expect(again.body).toEqual({ updated: 0 });
    });

    it('every role (also ADMIN) can read its own notifications', async () => {
      await http().get(`${API}/notifications`).set(as('admin')).expect(200);
      await http()
        .get(`${API}/notifications/unread-count`)
        .set(as('supA'))
        .expect(200);
    });

    it('Swagger documents the routes', () => {
      const paths = Object.keys(createSwaggerDocument(app).paths);
      expect(paths).toEqual(
        expect.arrayContaining([
          `${API}/notifications`,
          `${API}/notifications/unread`,
          `${API}/notifications/unread-count`,
          `${API}/notifications/{id}/read`,
          `${API}/notifications/read-all`,
          `${API}/projects/{id}/status`,
        ]),
      );
    });
  });

  // ==================================================================
  describe('Duplicate prevention', () => {
    beforeEach(clearAll);

    it('the same event (dedupeKey) is stored once per user', async () => {
      const input = {
        type: 'SYSTEM_ALERT' as const,
        title: 't',
        message: 'm',
        dedupeKey: 'event-1',
        email: true,
      };
      const first = await notifications.notify(
        [users.alice.id, users.bob.id],
        input,
      );
      const second = await notifications.notify(
        [users.alice.id, users.bob.id, users.erin.id],
        input,
      );
      expect(first).toHaveLength(2);
      expect(second.map((n) => n.userId)).toEqual([users.erin.id]); // only the new user
      expect(db.notification.rows).toHaveLength(3);
      expect(db.emailDelivery.rows).toHaveLength(3); // one email per user and event
    });

    it('queued emails trigger a send soon; deduplicated events do not', async () => {
      flush.mockClear();
      const input = {
        type: 'SYSTEM_ALERT' as const,
        title: 't',
        message: 'm',
        dedupeKey: 'flush-1',
        email: true,
      };
      await notifications.notify([users.alice.id], input);
      expect(flush).toHaveBeenCalledTimes(1);
      await notifications.notify([users.alice.id], input);
      expect(flush).toHaveBeenCalledTimes(1);
    });

    it('notifications without a key are independent events', async () => {
      await notifications.notify([users.alice.id], {
        type: 'SYSTEM_ALERT',
        title: 't',
        message: 'm',
      });
      await notifications.notify([users.alice.id], {
        type: 'SYSTEM_ALERT',
        title: 't',
        message: 'm',
      });
      expect(rowsOf('alice')).toHaveLength(2);
    });
  });

  // ==================================================================
  describe('Deadline reminders (scheduled job)', () => {
    const now = new Date();
    const task = async (
      title: string,
      due: Date,
      status = 'TODO',
      assignee?: string,
    ) =>
      (await db.task.create({
        data: {
          projectId: projectA,
          title,
          status,
          dueDate: due,
          assignedToId: assignee ? users[assignee].id : null,
          createdById: users.alice.id,
        },
      }))!;

    beforeAll(async () => {
      clearAll();
      db.task.rows.length = 0;
      await task(
        'Soon (bob)',
        new Date(now.getTime() + 3 * HOUR),
        'IN_PROGRESS',
        'bob',
      );
      await task('Soon (team)', new Date(now.getTime() + 20 * HOUR));
      await task('Later', new Date(now.getTime() + 48 * HOUR));
      await task('Overdue (team)', new Date(now.getTime() - 2 * DAY - HOUR));
      await task('Too old', new Date(now.getTime() - 30 * DAY));
      await task(
        'Done soon',
        new Date(now.getTime() + 2 * HOUR),
        'COMPLETED',
        'bob',
      );
      await task('Cancelled late', new Date(now.getTime() - HOUR), 'CANCELLED');
    });

    it('creates due-soon and overdue reminders for the right students', async () => {
      const result = await reminders.run(now);
      expect(result).toMatchObject({ dueSoonTasks: 2, overdueTasks: 1 });

      const titles = (key: string) =>
        rowsOf(key)
          .map((n: any) => `${n.type}:${n.message}`)
          .sort();
      expect(titles('bob')).toEqual([
        'TASK_DUE_SOON:"Soon (bob)" is due in about 3 hours.',
        'TASK_DUE_SOON:"Soon (team)" is due in about 20 hours.',
        'TASK_OVERDUE:"Overdue (team)" is overdue by 2 days.',
      ]);
      // alice is not the assignee of "Soon (bob)"
      expect(titles('alice')).toEqual([
        'TASK_DUE_SOON:"Soon (team)" is due in about 20 hours.',
        'TASK_OVERDUE:"Overdue (team)" is overdue by 2 days.',
      ]);
      expect(rowsOf('erin')).toHaveLength(0);
      expect(rowsOf('supA')).toHaveLength(0);
      expect(result.notificationsCreated).toBe(5);
      expect(rowsOf('bob')[0].data).toMatchObject({ projectId: projectA });
    });

    it('running again (or many times) creates no duplicates', async () => {
      const before = db.notification.rows.length;
      for (let i = 0; i < 3; i++) {
        const r = await reminders.run(new Date(now.getTime() + i * 60_000));
        expect(r.notificationsCreated).toBe(0);
      }
      await Promise.all([reminders.run(now), reminders.run(now)]); // concurrent
      expect(db.notification.rows.length).toBe(before);
      expect(db.emailDelivery.rows.length).toBe(before); // one email each, no more
    });

    it('a moved deadline is a new reminder', async () => {
      const t = db.task.rows.find((r: any) => r.title === 'Soon (team)')!;
      t.dueDate = new Date(now.getTime() + 10 * HOUR);
      const r = await reminders.run(now);
      expect(r.notificationsCreated).toBe(2); // alice + bob
    });

    it('deadline reminder emails are sent once to the right addresses', async () => {
      const result = await outbox.dispatch(new Date(now.getTime() + 60_000));
      expect(result.failed).toBe(0);
      expect(result.sent).toBe(db.emailDelivery.rows.length);
      expect(mail.sent.map((m) => m.to).sort()).toEqual(
        [
          ...Array(4).fill('bob@test.local'),
          ...Array(3).fill('alice@test.local'),
        ].sort(),
      );
      expect(mail.sent[0].subject).toMatch(
        /^(تممها \| (تذكير بموعد تسليم مهمة|مهمة تجاوزت موعدها المحدد)|Tammha \| (Task Deadline Reminder|Overdue Task))$/,
      );
      expect(
        db.emailDelivery.rows.every(
          (m: any) => m.status === 'SENT' && m.sentAt,
        ),
      ).toBe(true);
      const again = await outbox.dispatch(new Date(now.getTime() + 120_000));
      expect(again.sent).toBe(0);
      expect(mail.sent).toHaveLength(7);
    });
  });

  // ==================================================================
  describe('Email failures never affect in-app notifications', () => {
    const input = (key: string) => ({
      type: 'SYSTEM_ALERT' as const,
      title: 'Important',
      message: 'Something important',
      dedupeKey: key,
      email: true,
    });
    beforeEach(clearAll);

    it('a provider error is retried with backoff, then succeeds', async () => {
      await notifications.notify([users.alice.id], input('retry-1'));
      expect(rowsOf('alice')).toHaveLength(1);
      mail.failNext('ETIMEDOUT');

      const t0 = new Date(Date.now() + 1000);
      expect(await outbox.dispatch(t0)).toEqual({
        sent: 0,
        failed: 0,
        retrying: 1,
      });
      const row = mailsOf('alice')[0];
      expect(row).toMatchObject({
        status: 'PENDING',
        attempts: 1,
        lastError: 'ETIMEDOUT',
      });
      expect(row.nextAttemptAt.getTime()).toBeGreaterThan(t0.getTime());
      // not yet due
      expect((await outbox.dispatch(t0)).sent).toBe(0);
      // after the backoff
      expect(
        (await outbox.dispatch(new Date(t0.getTime() + 2 * 60_000))).sent,
      ).toBe(1);
      expect(mailsOf('alice')[0]).toMatchObject({
        status: 'SENT',
        attempts: 2,
        lastError: null,
      });
      expect(rowsOf('alice')).toHaveLength(1); // in-app untouched
    });

    it('after EMAIL_MAX_ATTEMPTS (3) the email is FAILED; the error text is never stored', async () => {
      await notifications.notify([users.bob.id], input('fail-1'));
      mail.failNext('ECONNREFUSED', 3);
      let t = Date.now() + 1000;
      for (let i = 0; i < 3; i++) {
        await outbox.dispatch(new Date(t));
        t += 2 * HOUR;
      }
      const row = mailsOf('bob')[0];
      expect(row).toMatchObject({
        status: 'FAILED',
        attempts: 3,
        lastError: 'ECONNREFUSED',
      });
      expect(JSON.stringify(row)).not.toContain('FAKE-PROVIDER-SECRET');
      expect(mail.sent).toHaveLength(0);
      expect(rowsOf('bob')).toHaveLength(1);
    });

    it('INTEGRATION_NOT_IMPLEMENTED fails at once (no pointless retries)', async () => {
      await notifications.notify([users.alice.id], input('ni-1'));
      mail.failNext('INTEGRATION_NOT_IMPLEMENTED');
      expect(await outbox.dispatch(new Date(Date.now() + 1000))).toEqual({
        sent: 0,
        failed: 1,
        retrying: 0,
      });
      expect(mailsOf('alice')[0]).toMatchObject({
        status: 'FAILED',
        attempts: 1,
      });
    });

    it('a deactivated user is not emailed', async () => {
      await notifications.notify([users.erin.id], input('inactive-1'));
      const erin = db.user.rows.find((u: any) => u.id === users.erin.id)!;
      erin.isActive = false;
      await outbox.dispatch(new Date(Date.now() + 1000));
      erin.isActive = true;
      expect(mailsOf('erin')[0]).toMatchObject({
        status: 'FAILED',
        lastError: 'RECIPIENT_UNAVAILABLE',
      });
      expect(mail.sent).toHaveLength(0);
    });

    it('two dispatch calls at the same time send each email once', async () => {
      await notifications.notify(
        [users.alice.id, users.bob.id],
        input('concurrent-1'),
      );
      const when = new Date(Date.now() + 1000);
      await Promise.all([
        outbox.dispatch(when),
        outbox.dispatch(when),
        outbox.dispatch(when),
      ]);
      expect(mail.sent).toHaveLength(2);
    });

    it('email disabled: in-app notification only, nothing queued', async () => {
      mail.enabled = false;
      await notifications.notify([users.alice.id], input('disabled-1'));
      expect(rowsOf('alice')).toHaveLength(1);
      expect(db.emailDelivery.rows).toHaveLength(0);
      expect(await outbox.dispatch(new Date(Date.now() + 1000))).toEqual({
        sent: 0,
        failed: 0,
        retrying: 0,
      });
    });
  });

  // ==================================================================
  describe('Event notifications', () => {
    let docId = '';
    beforeEach(clearAll);

    it('a regular upload notifies nobody (no review requested)', async () => {
      const before = rowsOf('supA').length;
      await http()
        .post(`${API}/documents/upload`)
        .set(as('bob'))
        .field('projectId', projectA)
        .field('title', 'Notes')
        .attach('file', PDF, {
          filename: 'n.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);
      expect(rowsOf('supA')).toHaveLength(before);
    });

    it('document sent for review: supervisor gets DOCUMENT_SUBMITTED (in-app + e-mail)', async () => {
      const res = await http()
        .post(`${API}/documents/upload`)
        .set(as('bob'))
        .field('projectId', projectA)
        .field('title', 'Chapter 2')
        .field('submitForReview', 'true')
        .attach('file', PDF, {
          filename: 'c.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);
      docId = res.body.id;
      expect(rowsOf('supA').map((n: any) => n.type)).toEqual([
        'DOCUMENT_SUBMITTED',
      ]);
      expect(mailsOf('supA')).toHaveLength(1);
      // the uploader is never notified about their own upload
      expect(rowsOf('bob')).toHaveLength(0);
      expect(mailsOf('bob')).toHaveLength(0);
    });

    it('important decision (CHANGES_REQUESTED): students notified + emailed', async () => {
      await http()
        .patch(`${API}/documents/${docId}/submission-status`)
        .set(as('supA'))
        .send({ status: 'CHANGES_REQUESTED', comment: 'Fix chapter 2' })
        .expect(200);
      for (const s of ['alice', 'bob']) {
        expect(rowsOf(s).map((n: any) => n.type)).toEqual([
          'SUBMISSION_STATUS_CHANGED',
        ]);
        expect(mailsOf(s)).toHaveLength(1);
        expect(mailsOf(s)[0].textBody).toContain('يتطلب تعديلات');
      }
      expect(rowsOf('supA')).toHaveLength(0);
    });

    it('every supervisor review and comment reaches the students in-app AND by e-mail', async () => {
      await http()
        .patch(`${API}/documents/${docId}/submission-status`)
        .set(as('supA'))
        .send({ status: 'UNDER_REVIEW' })
        .expect(200);
      await http()
        .post(`${API}/feedback`)
        .set(as('supA'))
        .send({ projectId: projectA, comment: 'Nice progress' })
        .expect(201);
      expect(
        rowsOf('alice')
          .map((n: any) => n.type)
          .sort(),
      ).toEqual(['FEEDBACK_RECEIVED', 'SUBMISSION_STATUS_CHANGED']);
      for (const s of ['alice', 'bob']) {
        expect(
          mailsOf(s)
            .map((m: any) => m.type)
            .sort(),
        ).toEqual(['FEEDBACK_RECEIVED', 'SUBMISSION_STATUS_CHANGED']);
      }
      // never the supervisor who wrote them
      expect(mailsOf('supA')).toHaveLength(0);
    });

    it('review decisions with a written comment reach notifications and e-mails (no grades)', async () => {
      await http()
        .patch(`${API}/documents/${docId}/submission-status`)
        .set(as('supA'))
        .send({ status: 'APPROVED' })
        .expect(200);
      await http()
        .post(`${API}/feedback`)
        .set(as('supA'))
        .send({
          documentId: docId,
          status: 'REJECTED',
          comment: 'Please rework section 2',
        })
        .expect(201);
      expect(mailsOf('bob').length).toBe(2);
    });
  });

  // ==================================================================
  describe('Project status changes', () => {
    beforeEach(clearAll);
    const change = (who: string, status: string, note?: string) =>
      http()
        .patch(`${API}/projects/${projectA}/status`)
        .set(as(who))
        .send({ status, ...(note && { note }) });

    it('student moves PLANNING -> IN_PROGRESS: everyone else notified + emailed', async () => {
      const res = await change('alice', 'IN_PROGRESS', 'Kick-off done').expect(
        200,
      );
      expect(res.body).toMatchObject({
        projectId: projectA,
        previousStatus: 'PLANNING',
        status: 'IN_PROGRESS',
      });
      expect(rowsOf('alice')).toHaveLength(0); // the actor
      for (const who of ['bob', 'supA']) {
        expect(rowsOf(who)).toHaveLength(1);
        expect(rowsOf(who)[0]).toMatchObject({
          type: 'PROJECT_STATUS_CHANGED',
          message:
            '"Project A" moved from Planning to In progress. Note: Kick-off done',
        });
        expect(mailsOf(who)).toHaveLength(1);
      }
      expect(rowsOf('erin')).toHaveLength(0);
    });

    it('members cannot change the status; the leader cannot complete; same status -> 409', async () => {
      const member = await change('bob', 'REVIEW').expect(403);
      expect(member.body.code).toBe('NOT_TEAM_LEADER');
      const denied = await change('alice', 'COMPLETED').expect(403);
      expect(denied.body.code).toBe('PROJECT_STATUS_NOT_ALLOWED');
      const same = await change('alice', 'IN_PROGRESS').expect(409);
      expect(same.body.code).toBe('PROJECT_STATUS_UNCHANGED');
      expect(db.notification.rows).toHaveLength(0);
    });

    it('leader submits for review; supervisor completes it', async () => {
      await change('alice', 'REVIEW').expect(200);
      expect(rowsOf('supA')).toHaveLength(1);
      await change('supA', 'COMPLETED').expect(200);
      expect(rowsOf('bob').map((n: any) => n.message)).toEqual([
        '"Project A" moved from In progress to Under review.',
        '"Project A" moved from Under review to Completed.',
      ]);
      const denied = await change('alice', 'IN_PROGRESS').expect(403); // only the supervisor reopens
      expect(denied.body.code).toBe('PROJECT_STATUS_NOT_ALLOWED');
      await change('supA', 'IN_PROGRESS').expect(200);
    });

    it('other users, ADMIN and bad input are rejected', async () => {
      await change('erin', 'REVIEW').expect(403);
      await change('supB', 'REVIEW').expect(403);
      await change('admin', 'REVIEW').expect(403);
      await change('alice', 'DONE').expect(400);
      await http()
        .patch(`${API}/projects/${projectA}/status`)
        .set(as('alice'))
        .send({})
        .expect(400);
      await http()
        .patch(`${API}/projects/nope/status`)
        .set(as('supA'))
        .send({ status: 'REVIEW' })
        .expect(404);
      expect(db.notification.rows).toHaveLength(0);
    });
  });

  // ==================================================================
  describe('Meeting events (ready for the meetings API)', () => {
    let meetingId = '';
    beforeEach(clearAll);

    it('scheduled: team + supervisor (minus the organiser) notified and emailed, once', async () => {
      const m = await db.meeting.create({
        data: {
          projectId: projectA,
          title: 'Weekly sync',
          scheduledAt: new Date('2026-11-02T09:00:00Z'),
          duration: 30,
          location: 'Room 12',
          createdById: users.supA.id,
        },
      });
      meetingId = m!.id;
      await meetings.notifyMeetingChange(meetingId, 'SCHEDULED', users.supA.id);
      await meetings.notifyMeetingChange(meetingId, 'SCHEDULED', users.supA.id); // repeat
      expect(rowsOf('supA')).toHaveLength(0);
      for (const s of ['alice', 'bob']) {
        expect(rowsOf(s)).toHaveLength(1);
        expect(rowsOf(s)[0]).toMatchObject({
          type: 'MEETING_INVITATION',
          message:
            '"Weekly sync" is scheduled for 2026-11-02 09:00 UTC (Room 12).',
        });
        expect(mailsOf(s)).toHaveLength(1);
      }
    });

    it('updated and cancelled are separate events; attendees only when listed', async () => {
      const m = db.meeting.rows.find((r: any) => r.id === meetingId)!;
      await db.meetingAttendee.create({
        data: { meetingId, userId: users.bob.id },
      });
      m.scheduledAt = new Date('2026-11-03T10:30:00Z');
      m.updatedAt = new Date(m.updatedAt.getTime() + 1000);
      await meetings.notifyMeetingChange(meetingId, 'UPDATED', users.supA.id);
      m.updatedAt = new Date(m.updatedAt.getTime() + 1000);
      await meetings.notifyMeetingChange(meetingId, 'CANCELLED', users.supA.id);
      expect(rowsOf('alice')).toHaveLength(0); // not an attendee
      expect(rowsOf('bob').map((n: any) => n.type)).toEqual([
        'MEETING_UPDATED',
        'MEETING_CANCELLED',
      ]);
      expect(mailsOf('bob')).toHaveLength(2);
    });

    it('an unknown meeting is ignored', async () => {
      expect(
        await meetings.notifyMeetingChange('nope', 'UPDATED', null),
      ).toEqual([]);
    });
  });
});
