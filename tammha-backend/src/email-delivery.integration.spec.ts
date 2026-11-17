import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '@/prisma/prisma.service';
import { configureApp } from '@/app.setup';
import { testConfigModule } from '@/testing/test-env';
import {
  createInMemoryPrisma,
  InMemoryPrisma,
} from '@/testing/in-memory-prisma';
import { FakeStorageService } from '@/testing/fake-storage';
import { FakeSmtpTransport } from '@/testing/fake-smtp-transport';
import {
  IntegrationsModule,
  SMTP_TRANSPORT_FACTORY,
} from '@/integrations/integrations.module';
import { AuthModule } from '@modules/auth/auth.module';
import { UsersModule } from '@modules/users/users.module';
import { TeamsModule } from '@modules/teams/teams.module';
import { ProjectsModule } from '@modules/projects/projects.module';
import { TasksModule } from '@modules/tasks/tasks.module';
import { MilestonesModule } from '@modules/milestones/milestones.module';
import { DocumentsModule } from '@modules/documents/documents.module';
import { FeedbackModule } from '@modules/feedback/feedback.module';
import { MeetingsModule } from '@modules/meetings/meetings.module';
import { NotificationsModule } from '@modules/notifications/notifications.module';
import { DashboardModule } from '@modules/dashboard/dashboard.module';
import { SupabaseStorageService } from '@modules/documents/supabase-storage.service';
import { EmailOutboxService } from '@modules/notifications/email/email-outbox.service';
import { NotificationsService } from '@modules/notifications/notifications.service';
import { TaskRemindersService } from '@modules/notifications/reminders/task-reminders.service';
import { AccountEmailService } from '@modules/auth/account-email.service';
import { SupervisorAccountsService } from '@modules/auth/supervisor-accounts.service';
import { verificationCodeIn } from '@/testing/verification-code';

/**
 * Production e-mail path with SMTP enabled: real SmtpEmailSender, real outbox
 * (email_deliveries) and real dispatcher; only the SMTP connection is a fake.
 *
 * - account e-mail verification is required (EMAIL_VERIFICATION_REQUIRED follows EMAIL_ENABLED)
 * - every important event is e-mailed to the recipient's ACCOUNT e-mail, never to the actor
 * - duplicates are suppressed by the outbox (userId + dedupeKey)
 * - an SMTP failure never fails the business action; retries and FAILED are tracked
 */
const API = '/api/v1';
const PASSWORD = 'Password123';
const DAY = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();

describe('E-mail delivery over SMTP (integration)', () => {
  let app: INestApplication;
  let db: InMemoryPrisma;
  let outbox: EmailOutboxService;
  const smtp = new FakeSmtpTransport();
  let universityId = '';
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  // account e-mails are stored lower-case
  const email = (k: string) => `${k.toLowerCase()}@gmail.test`;
  const p = { projectId: '', teamId: '', code: '', taskId: '' };

  const http = () => request(app.getHttpServer());
  const as = (k: string) => ({ Authorization: `Bearer ${tokens[k]}` });
  const linkIn = (to: string, kind: string) => {
    const mail = [...smtp.to(to)]
      .reverse()
      .find((m) => m.text.includes(`/${kind}.html?token=`));
    return mail ? /token=([A-Za-z0-9_-]{43})/.exec(mail.text)![1] : null;
  };
  /** P17: the latest verification code e-mailed to this address */
  const codeIn = (to: string) =>
    [...smtp.to(to)]
      .reverse()
      .map((m) => verificationCodeIn(m.text))
      .find((c) => !!c) ?? null;
  /** delivers everything due now (as the scheduler would) */
  const flush = async () => outbox.dispatch(new Date(Date.now() + 1000));
  const mailsTo = (k: string, type?: NotificationType) =>
    db.emailDelivery.rows.filter(
      (r: any) => r.userId === ids[k] && (!type || r.type === type),
    );

  async function register(
    key: string,
    role: 'STUDENT' | 'SUPERVISOR',
    extra = {},
  ) {
    if (role === 'SUPERVISOR') {
      // supervisors cannot self-register: created by an ADMIN, activated by e-mail
      await app.get(SupervisorAccountsService).create({
        email: email(key),
        firstName: key[0].toUpperCase() + key.slice(1),
        universityId,
      });
      await http()
        .post(`${API}/auth/activate-account`)
        .send({
          token: linkIn(email(key), 'activate-account'),
          newPassword: PASSWORD,
        })
        .expect(200);
      const login = await http()
        .post(`${API}/auth/login`)
        .send({ email: email(key), password: PASSWORD })
        .expect(200);
      tokens[key] = login.body.tokens.accessToken;
      ids[key] = login.body.user.id;
      return login.body;
    }
    const res = await http()
      .post(`${API}/auth/register`)
      .send({
        email: email(key),
        password: PASSWORD,
        firstName: key[0].toUpperCase() + key.slice(1),
        role,
        universityId,
        studentNumber: `UM-${key.toUpperCase()}`,
        preferredLanguage: 'en',
        // without a separate universityEmail, the account e-mail is the university e-mail
        accountEmailIsUniversityEmail: !('universityEmail' in extra),
        ...extra,
      })
      .expect(201);
    tokens[key] = res.body.tokens.accessToken;
    ids[key] = res.body.user.id;
    return res.body;
  }
  async function verify(key: string) {
    await http()
      .post(`${API}/auth/verify-email/code`)
      .send({ email: email(key), code: codeIn(email(key)) })
      .expect(200);
  }

  beforeAll(async () => {
    db = createInMemoryPrisma();
    universityId = (await db.university.create({
      data: { name: 'Almaarefa University', code: 'UM' },
    }))!.id;
    const moduleRef = await Test.createTestingModule({
      imports: [
        testConfigModule({
          EMAIL_ENABLED: 'true',
          SMTP_HOST: 'smtp.mail-provider.test',
          SMTP_USER: 'support@tammha.site',
          SMTP_PASSWORD: 'test-only-smtp-password',
          EMAIL_FROM: 'Tammha <support@tammha.site>',
          EMAIL_MAX_ATTEMPTS: '2',
        }),
        IntegrationsModule,
        AuthModule,
        UsersModule,
        TeamsModule,
        ProjectsModule,
        TasksModule,
        MilestonesModule,
        DocumentsModule,
        FeedbackModule,
        MeetingsModule,
        NotificationsModule,
        DashboardModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(db)
      .overrideProvider(SupabaseStorageService)
      .useValue(new FakeStorageService())
      .overrideProvider(SMTP_TRANSPORT_FACTORY)
      .useValue(() => smtp)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    outbox = app.get(EmailOutboxService);
  });

  afterAll(async () => {
    await app?.close();
  });

  // ==================================================================
  describe('Account e-mail verification is required', () => {
    it('registration sends the verification CODE from the noreply address and says verification is required', async () => {
      const body = await register('leila', 'STUDENT');
      expect(body.emailVerificationRequired).toBe(true);
      expect(body.user.emailVerified).toBe(false);
      const [mail] = smtp.to(email('leila'));
      const code = codeIn(email('leila'));
      expect(code).toMatch(/^\d{6}$/);
      expect(mail).toMatchObject({
        // P17: codes come from noreply@ (same domain as EMAIL_FROM), no links at all
        from: 'Tammha <noreply@tammha.site>',
        to: email('leila'),
        subject: `Tammha | Your verification code: ${code}`,
      });
      expect(mail.text).not.toContain('http');
      expect(mail.html).not.toMatch(/https?:/);
      expect(mail.html).toContain(code);
      // account e-mails never go through the database outbox (their tokens stay hashed)
      expect(db.emailDelivery.rows).toHaveLength(0);
    });

    it('an unverified account can only use the verification flow', async () => {
      for (const attempt of [
        () =>
          http()
            .post(`${API}/projects`)
            .set(as('leila'))
            .send({ name: 'Too early' }),
        () =>
          http().post(`${API}/users/me/onboarding/complete`).set(as('leila')),
        () => http().get(`${API}/dashboard/student`).set(as('leila')),
        () => http().get(`${API}/notifications`).set(as('leila')),
      ]) {
        const res = await attempt().expect(403);
        expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
      }
      // allowed: who am I, resend (here: cooldown), logout
      const me = await http()
        .get(`${API}/auth/me`)
        .set(as('leila'))
        .expect(200);
      expect(me.body.emailVerified).toBe(false);
      const resend = await http()
        .post(`${API}/auth/resend-verification`)
        .set(as('leila'))
        .expect(429);
      expect(resend.body.code).toBe('VERIFICATION_RECENTLY_SENT');
      const login = await http()
        .post(`${API}/auth/login`)
        .send({ email: email('leila'), password: PASSWORD })
        .expect(200);
      expect(login.body).toMatchObject({
        emailVerificationRequired: true,
        user: { emailVerified: false },
      });
    });

    it('after verifying, the product flow opens', async () => {
      await verify('leila');
      await http()
        .post(`${API}/users/me/onboarding/complete`)
        .set(as('leila'))
        .expect(200);
      const res = await http()
        .post(`${API}/projects`)
        .set(as('leila'))
        .send({ name: 'Campus Navigator' })
        .expect(201);
      p.projectId = res.body.project.id;
      p.teamId = res.body.team.id;
      p.code = res.body.invitation.code;
    });

    it('password reset still works for an unverified account and verifies it', async () => {
      await register('noor', 'STUDENT');
      await http()
        .post(`${API}/auth/forgot-password`)
        .send({ email: email('noor') })
        .expect(200);
      await http()
        .post(`${API}/auth/reset-password`)
        .send({
          token: linkIn(email('noor'), 'reset-password'),
          newPassword: 'NewPassword456',
        })
        .expect(200);
      const login = await http()
        .post(`${API}/auth/login`)
        .send({ email: email('noor'), password: 'NewPassword456' })
        .expect(200);
      tokens.noor = login.body.tokens.accessToken;
      expect(login.body.user.emailVerified).toBe(true);
      await http()
        .post(`${API}/teams/join`)
        .set(as('noor'))
        .send({ code: p.code })
        .expect(200);
    });

    it('SMTP down during registration: the account is still created; the code is retried in the background', async () => {
      smtp.failNext({ code: 'ECONNECTION' });
      await register('omar', 'STUDENT', {
        universityEmail: 'omar.k@um.edu.sa',
      });
      expect(app.get(AccountEmailService).pendingRetries).toBe(1);
      expect(db.user.rows.some((u: any) => u.email === email('omar'))).toBe(
        true,
      );
      // the university-e-mail link (separate address) was still sent
      expect(
        linkIn('omar.k@um.edu.sa', 'verify-university-email'),
      ).not.toBeNull();
      // a new account link on request
      for (const t of db.authToken.rows as any[]) {
        if (t.userId === ids.omar) t.createdAt = new Date(Date.now() - 120_000);
      }
      await http()
        .post(`${API}/auth/resend-verification`)
        .set(as('omar'))
        .expect(200);
      await verify('omar');
      // account e-mail verified, university e-mail (separate address) not yet: no full access
      const gated = await http()
        .get(`${API}/dashboard/student`)
        .set(as('omar'))
        .expect(403);
      expect(gated.body).toMatchObject({
        code: 'UNIVERSITY_EMAIL_NOT_VERIFIED',
        details: { pending: true },
      });
      // the university e-mail route itself stays reachable (a new link is sent)
      const again = await http()
        .post(`${API}/auth/university-email`)
        .set(as('omar'))
        .send({ universityEmail: 'omar.k@um.edu.sa' })
        .expect(200);
      expect(again.body.status).toBe('PENDING_VERIFICATION');
      await http()
        .post(`${API}/auth/verify-university-email`)
        .send({ token: linkIn('omar.k@um.edu.sa', 'verify-university-email') })
        .expect(200);
      await register('supA', 'SUPERVISOR'); // activation verifies the e-mail
      smtp.reset();
    });
  });

  // ==================================================================
  describe('Important events reach the ACCOUNT e-mail through the outbox', () => {
    it('team invitation: to the invitee account e-mail (not the university e-mail), from the project mailbox', async () => {
      await http()
        .post(`${API}/teams/${p.teamId}/student-invitations`)
        .set(as('leila'))
        .send({ universityEmail: 'omar.k@um.edu.sa' })
        .expect(201);
      expect(mailsTo('omar', 'TEAM_INVITATION')).toHaveLength(1);
      const result = await flush();
      expect(result.sent).toBeGreaterThanOrEqual(1);
      expect(smtp.to('omar.k@um.edu.sa')).toHaveLength(0);
      const [mail] = smtp.to(email('omar'));
      expect(mail).toMatchObject({
        from: 'Tammha <support@tammha.site>',
        subject: 'Tammha | Team Invitation',
      });
      expect(mailsTo('omar', 'TEAM_INVITATION')[0]).toMatchObject({
        status: 'SENT',
        provider: 'smtp',
      });
      const invitationId = (
        await http()
          .get(`${API}/team-invitations/incoming`)
          .set(as('omar'))
          .expect(200)
      ).body[0].id;
      await http()
        .post(`${API}/team-invitations/${invitationId}/accept`)
        .set(as('omar'))
        .expect(200);
      expect(mailsTo('leila', 'TEAM_INVITATION')).toHaveLength(1); // "invitation accepted"
    });

    it('supervisor request and answer', async () => {
      const req = await http()
        .post(`${API}/projects/${p.projectId}/supervision-requests`)
        .set(as('leila'))
        .send({ supervisorEmail: email('supA') })
        .expect(201);
      expect(mailsTo('supA', 'SUPERVISION_REQUESTED')).toHaveLength(1);
      await http()
        .post(`${API}/supervision-requests/${req.body.id}/accept`)
        .set(as('supA'))
        .send({})
        .expect(200);
      for (const k of ['leila', 'noor', 'omar']) {
        expect(mailsTo(k, 'SUPERVISION_RESPONDED')).toHaveLength(1);
      }
      expect(mailsTo('supA', 'SUPERVISION_RESPONDED')).toHaveLength(0);
    });

    it('supervisor feedback, comments and review decisions: every student, in-app AND e-mail; never the supervisor', async () => {
      await http()
        .post(`${API}/feedback`)
        .set(as('supA'))
        .send({ projectId: p.projectId, comment: 'Please narrow the scope.' })
        .expect(201);
      const doc = await http()
        .post(`${API}/documents/upload`)
        .set(as('noor'))
        .field('projectId', p.projectId)
        .field('title', 'Proposal')
        .field('submitForReview', 'true') // a formal submission notifies the supervisor
        .attach('file', Buffer.from('%PDF-1.4 test'), {
          filename: 'p.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);
      expect(mailsTo('supA', 'DOCUMENT_SUBMITTED')).toHaveLength(1);
      expect(mailsTo('noor', 'DOCUMENT_SUBMITTED')).toHaveLength(0);
      for (const status of ['UNDER_REVIEW', 'CHANGES_REQUESTED']) {
        await http()
          .patch(`${API}/documents/${doc.body.id}/submission-status`)
          .set(as('supA'))
          .send({ status, comment: `Decision ${status}` })
          .expect(200);
      }
      for (const k of ['leila', 'noor', 'omar']) {
        const inApp = db.notification.rows.filter(
          (n: any) =>
            n.userId === ids[k] &&
            ['FEEDBACK_RECEIVED', 'SUBMISSION_STATUS_CHANGED'].includes(n.type),
        );
        expect(inApp).toHaveLength(3);
        expect(
          mailsTo(k).filter((m: any) =>
            ['FEEDBACK_RECEIVED', 'SUBMISSION_STATUS_CHANGED'].includes(m.type),
          ),
        ).toHaveLength(3);
      }
      await flush();
      expect(
        smtp
          .to(email('noor'))
          .filter((m) => m.text.toLowerCase().includes('changes requested')),
      ).toHaveLength(1);
      expect(
        smtp
          .to(email('supA'))
          .some((m) => m.subject.toLowerCase().includes('feedback')),
      ).toBe(false);
    });

    it('task assignment, reassignment, important changes and deletion; never to the leader herself', async () => {
      const task = await http()
        .post(`${API}/tasks`)
        .set(as('leila'))
        .send({
          projectId: p.projectId,
          title: 'Map the library',
          assignedStudentId: ids.noor,
        })
        .expect(201);
      p.taskId = task.body.id;
      expect(mailsTo('noor', 'TASK_ASSIGNED')).toHaveLength(1);

      await http()
        .patch(`${API}/tasks/${p.taskId}`)
        .set(as('leila'))
        .send({ assignedStudentId: ids.omar })
        .expect(200);
      expect(mailsTo('omar', 'TASK_ASSIGNED')).toHaveLength(1);
      expect(
        mailsTo('noor', 'TASK_UPDATED').filter((m: any) =>
          m.subject.toLowerCase().includes('assignment changed'),
        ),
      ).toHaveLength(1);

      await http()
        .patch(`${API}/tasks/${p.taskId}`)
        .set(as('leila'))
        .send({ dueDate: inDays(5), priority: 'HIGH' })
        .expect(200);
      const changed = mailsTo('omar', 'TASK_UPDATED');
      expect(changed).toHaveLength(1);
      expect(changed[0].textBody).toContain('due date');
      expect(changed[0].textBody).toContain('priority HIGH');

      // a member's own status change notifies the leader on completion only
      await http()
        .patch(`${API}/tasks/${p.taskId}`)
        .set(as('omar'))
        .send({ status: 'COMPLETED' })
        .expect(200);
      expect(mailsTo('leila', 'TASK_UPDATED')).toHaveLength(1);
      expect(mailsTo('omar', 'TASK_UPDATED')).toHaveLength(1);

      const own = await http()
        .post(`${API}/tasks`)
        .set(as('leila'))
        .send({
          projectId: p.projectId,
          title: 'My own task',
          assignedStudentId: ids.leila,
        })
        .expect(201);
      expect(mailsTo('leila', 'TASK_ASSIGNED')).toHaveLength(0);
      await http()
        .delete(`${API}/tasks/${own.body.id}`)
        .set(as('leila'))
        .expect(200);

      await http()
        .delete(`${API}/tasks/${p.taskId}`)
        .set(as('leila'))
        .expect(200);
      expect(
        mailsTo('omar', 'TASK_UPDATED').filter((m: any) =>
          m.subject.toLowerCase().includes('removed'),
        ),
      ).toHaveLength(1);
    });

    it('meetings: scheduled, updated and cancelled are e-mailed to everyone but the organiser', async () => {
      const meeting = await http()
        .post(`${API}/meetings`)
        .set(as('supA'))
        .send({
          projectId: p.projectId,
          title: 'Weekly review',
          scheduledAt: inDays(3),
        })
        .expect(201);
      await http()
        .patch(`${API}/meetings/${meeting.body.id}`)
        .set(as('supA'))
        .send({ scheduledAt: inDays(4) })
        .expect(200);
      await http()
        .post(`${API}/meetings/${meeting.body.id}/cancel`)
        .set(as('supA'))
        .send({ reason: 'Holiday' })
        .expect(200);
      for (const k of ['leila', 'noor', 'omar']) {
        expect(
          mailsTo(k)
            .filter((m: any) => m.type.startsWith('MEETING_'))
            .map((m: any) => m.type)
            .sort(),
        ).toEqual([
          'MEETING_CANCELLED',
          'MEETING_INVITATION',
          'MEETING_UPDATED',
        ]);
      }
      expect(
        mailsTo('supA').filter((m: any) => m.type.startsWith('MEETING_')),
      ).toHaveLength(0);
    });

    it('deadlines (tasks and project stages) and project status changes', async () => {
      await http()
        .post(`${API}/tasks`)
        .set(as('leila'))
        .send({
          projectId: p.projectId,
          title: 'Submit proposal',
          assignedStudentId: ids.noor,
          dueDate: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString(),
        })
        .expect(201);
      await http()
        .post(`${API}/milestones`)
        .set(as('leila'))
        .send({
          projectId: p.projectId,
          title: 'Proposal stage',
          dueDate: inDays(2),
        })
        .expect(201);
      const run = await app.get(TaskRemindersService).run();
      expect(run).toMatchObject({ dueSoonTasks: 1, dueSoonMilestones: 1 });
      expect(mailsTo('noor', 'TASK_DUE_SOON')).toHaveLength(1);
      for (const k of ['leila', 'noor', 'omar']) {
        expect(mailsTo(k, 'MILESTONE_DUE')).toHaveLength(1);
      }
      // running again creates nothing new
      await app.get(TaskRemindersService).run();
      expect(mailsTo('noor', 'TASK_DUE_SOON')).toHaveLength(1);

      await http()
        .patch(`${API}/projects/${p.projectId}/status`)
        .set(as('leila'))
        .send({ status: 'IN_PROGRESS' })
        .expect(200);
      expect(mailsTo('supA', 'PROJECT_STATUS_CHANGED')).toHaveLength(1);
      expect(mailsTo('leila', 'PROJECT_STATUS_CHANGED')).toHaveLength(0);
    });

    it('every queued e-mail is delivered once to the account address', async () => {
      smtp.reset();
      await flush();
      const queued = db.emailDelivery.rows.filter(
        (r: any) => r.status === 'SENT',
      );
      expect(queued.length).toBeGreaterThan(10);
      for (const row of queued as any[]) {
        const user = db.user.rows.find((u: any) => u.id === row.userId);
        expect(user!.email).toMatch(/@gmail\.test$/);
      }
      // a second dispatch sends nothing again
      const again = await flush();
      expect(again).toEqual({ sent: 0, failed: 0, retrying: 0 });
    });
  });

  // ==================================================================
  describe('Deduplication and failure isolation', () => {
    it('the same event is e-mailed once per user', async () => {
      const notifications = app.get(NotificationsService);
      const input = {
        type: NotificationType.PROJECT_UPDATE,
        title: 'Same event',
        message: 'Sent twice, delivered once.',
        dedupeKey: 'test-dedupe:1',
        email: true,
      };
      await notifications.notify([ids.noor, ids.noor], input);
      await notifications.notify([ids.noor], input);
      expect(
        mailsTo('noor').filter((m: any) => m.dedupeKey === 'test-dedupe:1'),
      ).toHaveLength(1);
      smtp.reset();
      await flush();
      expect(
        smtp
          .to(email('noor'))
          .filter((m) => m.subject === 'Tammha | Same event'),
      ).toHaveLength(1);
    });

    it('SMTP outage: the feedback is saved, the e-mail is retried, then marked FAILED', async () => {
      smtp.reset();
      smtp.failNext({ code: 'ECONNECTION' }, 10);
      const res = await http()
        .post(`${API}/feedback`)
        .set(as('supA'))
        .send({ projectId: p.projectId, comment: 'Feedback during an outage' })
        .expect(201);
      expect(db.feedback.rows.some((f: any) => f.id === res.body.id)).toBe(
        true,
      );
      const rows = () =>
        db.emailDelivery.rows.filter(
          (r: any) =>
            r.notificationId &&
            r.type === 'FEEDBACK_RECEIVED' &&
            r.status !== 'SENT',
        );
      expect(rows()).toHaveLength(3);

      const first = await flush();
      expect(first).toMatchObject({ sent: 0, retrying: 3 });
      expect(rows()[0]).toMatchObject({
        status: 'PENDING',
        attempts: 1,
        lastError: 'EMAIL_CONNECTION_FAILED',
      });
      // EMAIL_MAX_ATTEMPTS=2: the next attempt (after the backoff) is the last one
      const second = await outbox.dispatch(
        new Date(Date.now() + 2 * 60 * 60 * 1000),
      );
      expect(second).toMatchObject({ failed: 3 });
      expect(
        rows().every((r: any) => r.status === 'FAILED' && r.attempts === 2),
      ).toBe(true);
      expect(JSON.stringify(rows())).not.toContain('SMTP-SECRET');
      // the in-app notifications are untouched
      expect(
        db.notification.rows.filter(
          (n: any) =>
            n.type === 'FEEDBACK_RECEIVED' && n.message.includes('feedback'),
        ).length,
      ).toBeGreaterThanOrEqual(3);
    });

    it('a rejected recipient is FAILED at once (no pointless retries); delivery resumes after the outage', async () => {
      smtp.reset();
      smtp.failNext({ code: 'EENVELOPE', responseCode: 550 });
      await http()
        .post(`${API}/tasks`)
        .set(as('leila'))
        .send({
          projectId: p.projectId,
          title: 'After the outage',
          assignedStudentId: ids.omar,
        })
        .expect(201);
      const result = await flush();
      expect(result).toMatchObject({ failed: 1 });
      const row = mailsTo('omar', 'TASK_ASSIGNED').pop() as any;
      expect(row).toMatchObject({
        status: 'FAILED',
        lastError: 'EMAIL_RECIPIENT_REJECTED',
      });

      await http()
        .post(`${API}/tasks`)
        .set(as('leila'))
        .send({
          projectId: p.projectId,
          title: 'Delivered again',
          assignedStudentId: ids.omar,
        })
        .expect(201);
      await flush();
      expect(
        smtp.to(email('omar')).some((m) => m.text.includes('Delivered again')),
      ).toBe(true);
    });
  });
});
