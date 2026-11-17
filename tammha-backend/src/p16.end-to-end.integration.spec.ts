import { readFileSync } from 'fs';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';
import { configureApp, createSwaggerDocument } from './app.setup';
import {
  createInMemoryPrisma,
  InMemoryPrisma,
} from './testing/in-memory-prisma';
import { FakeStorageService } from './testing/fake-storage';
import { FakeAiTextProvider } from './testing/fake-ai-provider';
import { FakeEmailSender } from './testing/fake-email-sender';
import { SupabaseStorageService } from '@modules/documents/supabase-storage.service';
import { AI_TEXT_PROVIDER } from '@/integrations/ai/ai.provider';
import { EMAIL_SENDER } from '@/integrations/email/email.sender';
import { ProjectHandbookService } from '@modules/ai-support/handbook/project-handbook.service';
import { verificationCodeIn } from '@/testing/verification-code';

/**
 * P16 END-TO-END FLOW on the real AppModule (all modules, guards, pipes, Swagger).
 * Replaced: PrismaService (in-memory store), storage, AI provider (fake Gemini) and the
 * e-mail sender (records messages). Nothing reaches a real external service.
 *
 * Account (verify e-mail, forgot/reset password, onboarding, studentNumber) ->
 * first-project setup (leader) -> invitations by studentNumber -> supervisor request ->
 * project details -> project handbook -> AI (conversations, task breakdown) ->
 * leader applies suggestions -> member progress -> dashboard / documents / feedback /
 * meetings / notifications regressions.
 */
const API = '/api/v1';
const FIXTURES = join(__dirname, 'testing/fixtures');
const HANDBOOK_PDF = readFileSync(join(FIXTURES, 'handbook-sample.pdf'));
const UNREADABLE_PDF = readFileSync(join(FIXTURES, 'unreadable-sample.pdf'));
const DOC_PDF = Buffer.from('%PDF-1.4 fake test document');
const PASSWORD = 'Password123';
const DAY = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();

describe('P16 end-to-end flow (AppModule integration)', () => {
  let app: INestApplication;
  let db: InMemoryPrisma;
  let handbooks: ProjectHandbookService;
  const storage = new FakeStorageService();
  const ai = new FakeAiTextProvider();
  const mail = new FakeEmailSender();
  let uni1 = '';
  let uni2 = '';

  const http = () => request(app.getHttpServer());
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const as = (k: string) => ({ Authorization: `Bearer ${tokens[k]}` });
  const lastLink = (to: string, kind: 'verify-email' | 'reset-password') => {
    const msg = [...mail.sent].reverse().find((m) => m.to === to);
    const match =
      msg &&
      new RegExp(`/${kind}\\.html\\?token=([A-Za-z0-9_-]{43})`).exec(msg.text);
    return match?.[1] ?? null;
  };
  /** P17: the latest verification code e-mailed to this address */
  const lastCode = (to: string) =>
    [...mail.sent]
      .reverse()
      .map((m) => (m.to === to ? verificationCodeIn(m.text) : null))
      .find((c) => !!c) ?? null;
  const notificationsOf = (k: string, type?: string) =>
    db.notification.rows.filter(
      (n: any) => n.userId === ids[k] && (!type || n.type === type),
    );

  let adminToken = '';
  /** Supervisors cannot self-register: an ADMIN creates them, they activate by e-mail. */
  async function createSupervisor(key: string, universityId: string) {
    if (!adminToken) {
      await db.user.create({
        data: {
          email: 'admin@uni.test',
          password: await bcrypt.hash(PASSWORD, 4),
          role: 'ADMIN',
          emailVerifiedAt: new Date(),
        },
      });
      adminToken = (
        await http()
          .post(`${API}/auth/login`)
          .send({ email: 'admin@uni.test', password: PASSWORD })
          .expect(200)
      ).body.tokens.accessToken;
    }
    const email = `${key}@uni.test`;
    await http()
      .post(`${API}/admin/supervisors`)
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({
        email,
        firstName: key[0].toUpperCase() + key.slice(1),
        lastName: 'Tester',
        universityId,
      })
      .expect(201);
    const msg = [...mail.sent]
      .reverse()
      .find((m) => m.to === email.toLowerCase())!;
    const token = /\/activate-account\.html\?token=([A-Za-z0-9_-]{43})/.exec(
      msg.text,
    )![1];
    await http()
      .post(`${API}/auth/activate-account`)
      .send({ token, newPassword: PASSWORD })
      .expect(200);
    const res = await http()
      .post(`${API}/auth/login`)
      .send({ email, password: PASSWORD })
      .expect(200);
    tokens[key] = res.body.tokens.accessToken;
    ids[key] = res.body.user.id;
    return res.body;
  }

  async function register(
    key: string,
    role: 'STUDENT' | 'SUPERVISOR',
    extra: Record<string, unknown> = {},
    universityId = uni1,
  ) {
    if (role === 'SUPERVISOR') return createSupervisor(key, universityId);
    const res = await http()
      .post(`${API}/auth/register`)
      .send({
        email: `${key}@uni.test`,
        password: PASSWORD,
        firstName: key[0].toUpperCase() + key.slice(1),
        lastName: 'Tester',
        role,
        universityId,
        // no university e-mail domains configured here: the account e-mail is the university e-mail
        accountEmailIsUniversityEmail: true,
        ...extra,
      })
      .expect(201);
    tokens[key] = res.body.tokens.accessToken;
    ids[key] = res.body.user.id;
    return res.body;
  }

  beforeAll(async () => {
    db = createInMemoryPrisma();
    uni1 = (await db.university.create({
      data: { name: 'Sample University', code: 'SAMPLE' },
    }))!.id;
    uni2 = (await db.university.create({
      data: { name: 'Other University', code: 'OTHER' },
    }))!.id;
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
    handbooks = app.get(ProjectHandbookService);
  });

  afterAll(async () => {
    await app?.close();
  });

  // ==================================================================
  describe('Authentication & account', () => {
    it('register exposes emailVerified/onboarding state and sends a verification link', async () => {
      const body = await register('leila', 'STUDENT', {
        studentNumber: ' s2026-001 ',
      });
      expect(body.user).toMatchObject({
        studentNumber: 'S2026-001',
        emailVerified: false,
        emailVerifiedAt: null,
        onboardingCompleted: false,
      });
      expect(body.user).not.toHaveProperty('password');
      // P17: a 6-digit code (no link); only its digest is stored
      const code = lastCode('leila@uni.test');
      expect(code).toMatch(/^\d{6}$/);
      const sentMail = [...mail.sent]
        .reverse()
        .find((m) => m.to === 'leila@uni.test')!;
      expect(sentMail.text).not.toContain('http');
      expect(JSON.stringify(db.authToken.rows)).not.toContain(`"${code}"`);
    });

    it('studentNumber is unique per university; students only', async () => {
      await register('noor', 'STUDENT', { studentNumber: 'S2026-002' });
      await register('omar', 'STUDENT', { studentNumber: 'S2026-003' });
      await register('sara', 'STUDENT', { studentNumber: 'S2026-004' });
      await register('erin', 'STUDENT', { studentNumber: 'S2026-005' });
      const dup = await http()
        .post(`${API}/auth/register`)
        .send({
          email: 'dup@uni.test',
          password: PASSWORD,
          role: 'STUDENT',
          universityId: uni1,
          studentNumber: 's2026-001',
          accountEmailIsUniversityEmail: true,
        })
        .expect(409);
      expect(dup.body.code).toBe('STUDENT_NUMBER_TAKEN');
      // same number in another university is fine
      await register('olga', 'STUDENT', { studentNumber: 'S2026-001' }, uni2);
      // a supervisor may register; the student number is ignored for supervisors
      const sup = await http()
        .post(`${API}/auth/register`)
        .send({
          email: 'nosn@uni.test',
          password: PASSWORD,
          role: 'SUPERVISOR',
          universityId: uni1,
          studentNumber: 'X-1234',
        })
        .expect(201);
      expect(sup.body.user.role).toBe('SUPERVISOR');
      expect(sup.body.user.studentNumber ?? null).toBeNull();
      await register('supA', 'SUPERVISOR');
      await register('supB', 'SUPERVISOR');
    });

    it('verify-email/code: the right code verifies once; reused or malformed code is rejected', async () => {
      const code = lastCode('leila@uni.test')!;
      const res = await http()
        .post(`${API}/auth/verify-email/code`)
        .send({ email: 'leila@uni.test', code })
        .expect(200);
      expect(res.body.emailVerified).toBe(true);
      const me = await http()
        .get(`${API}/auth/me`)
        .set(as('leila'))
        .expect(200);
      expect(me.body).toMatchObject({ emailVerified: true });
      expect(me.body.emailVerifiedAt).not.toBeNull();

      // already verified: answered as verified, the code is not needed again
      await http()
        .post(`${API}/auth/verify-email/code`)
        .send({ email: 'leila@uni.test', code })
        .expect(200);
      await http()
        .post(`${API}/auth/verify-email/code`)
        .send({ email: 'leila@uni.test', code: '12' })
        .expect(400);
    });

    it('resend-verification: cooldown, a new code replaces the old one, 409 once verified', async () => {
      const first = lastCode('noor@uni.test')!;
      const wait = await http()
        .post(`${API}/auth/resend-verification`)
        .set(as('noor'))
        .expect(429);
      expect(wait.body.code).toBe('VERIFICATION_RECENTLY_SENT');

      // move the previous code out of the cooldown window
      for (const t of db.authToken.rows as any[]) {
        if (t.userId === ids.noor) t.createdAt = new Date(Date.now() - 120_000);
      }
      const res = await http()
        .post(`${API}/auth/resend-verification`)
        .set(as('noor'))
        .expect(200);
      expect(res.body.emailDelivery).toBe('ENABLED');
      const second = lastCode('noor@uni.test')!;
      if (second !== first) {
        const old = await http()
          .post(`${API}/auth/verify-email/code`)
          .send({ email: 'noor@uni.test', code: first })
          .expect(400);
        expect(old.body.code).toBe('VERIFICATION_CODE_INVALID');
      }
      await http()
        .post(`${API}/auth/verify-email/code`)
        .send({ email: 'noor@uni.test', code: second })
        .expect(200);
      const done = await http()
        .post(`${API}/auth/resend-verification`)
        .set(as('leila'))
        .expect(409);
      expect(done.body.code).toBe('EMAIL_ALREADY_VERIFIED');
      await http().post(`${API}/auth/resend-verification`).expect(401);
    });

    it('forgot-password never reveals whether the e-mail exists', async () => {
      const before = mail.sent.length;
      const unknown = await http()
        .post(`${API}/auth/forgot-password`)
        .send({ email: 'nobody@uni.test' })
        .expect(200);
      expect(mail.sent.length).toBe(before);
      const known = await http()
        .post(`${API}/auth/forgot-password`)
        .send({ email: 'omar@uni.test' })
        .expect(200);
      expect(known.body).toEqual(unknown.body);
      expect(lastLink('omar@uni.test', 'reset-password')).toMatch(
        /^[A-Za-z0-9_-]{43}$/,
      );
    });

    it('reset-password: strong password required, sessions revoked, single use', async () => {
      const login = await http()
        .post(`${API}/auth/login`)
        .send({ email: 'omar@uni.test', password: PASSWORD })
        .expect(200);
      const token = lastLink('omar@uni.test', 'reset-password')!;
      await http()
        .post(`${API}/auth/reset-password`)
        .send({ token, newPassword: 'weak' })
        .expect(400);
      await http()
        .post(`${API}/auth/reset-password`)
        .send({ token, newPassword: 'NewPassword456' })
        .expect(200);
      // old refresh token revoked, old password refused, new one works
      await http()
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: login.body.tokens.refreshToken })
        .expect(401);
      await http()
        .post(`${API}/auth/login`)
        .send({ email: 'omar@uni.test', password: PASSWORD })
        .expect(401);
      const fresh = await http()
        .post(`${API}/auth/login`)
        .send({ email: 'omar@uni.test', password: 'NewPassword456' })
        .expect(200);
      tokens.omar = fresh.body.tokens.accessToken;
      expect(fresh.body.user.emailVerified).toBe(true); // the link proved the address
      const reused = await http()
        .post(`${API}/auth/reset-password`)
        .send({ token, newPassword: 'Another789x' })
        .expect(400);
      expect(reused.body.code).toBe('RESET_TOKEN_INVALID');
    });

    it('onboarding completion persists and is idempotent', async () => {
      const res = await http()
        .post(`${API}/users/me/onboarding/complete`)
        .set(as('leila'))
        .expect(200);
      expect(res.body.onboardingCompleted).toBe(true);
      const at = res.body.onboardingCompletedAt;
      const again = await http()
        .post(`${API}/users/me/onboarding/complete`)
        .set(as('leila'))
        .expect(200);
      expect(again.body.onboardingCompletedAt).toBe(at);
      const me = await http()
        .get(`${API}/auth/me`)
        .set(as('leila'))
        .expect(200);
      expect(me.body.onboardingCompleted).toBe(true);
    });

    it('student search by studentNumber returns safe data only, same university', async () => {
      const res = await http()
        .get(`${API}/students/search?studentNumber=s2026-002`)
        .set(as('leila'))
        .expect(200);
      expect(res.body).toEqual({
        displayName: 'Noor T.',
        matchedBy: 'STUDENT_NUMBER',
        maskedIdentifier: 'S2*****02',
        university: { id: uni1, name: 'Sample University' },
        availability: 'AVAILABLE',
      });
      expect(JSON.stringify(res.body)).not.toContain('@');
      const other = await http()
        .get(`${API}/students/search?studentNumber=S2026-001`)
        .set(as('olga'))
        .expect(200); // olga's own university has its own S2026-001 (herself)
      expect(other.body.availability).toBe('YOU');
      await http()
        .get(`${API}/students/search?studentNumber=S2026-999`)
        .set(as('leila'))
        .expect(404);
      await http()
        .get(`${API}/students/search?studentNumber=S2026-002`)
        .set(as('supA'))
        .expect(403);
    });
  });

  // ==================================================================
  const p = { projectId: '', teamId: '', inviteCode: '' };

  describe('First project setup (leader)', () => {
    it('the creator becomes LEADER; setup starts at TEAM and the dashboard says so', async () => {
      const res = await http()
        .post(`${API}/projects`)
        .set(as('leila'))
        .send({ name: 'Smart Campus Navigator' })
        .expect(201);
      p.projectId = res.body.project.id;
      p.teamId = res.body.team.id;
      p.inviteCode = res.body.invitation.code;
      expect(res.body.team.members[0]).toMatchObject({
        userId: ids.leila,
        teamRole: 'LEADER',
      });
      expect(res.body.viewer).toMatchObject({ isLeader: true });
      expect(res.body.project.setup).toMatchObject({
        step: 'TEAM',
        completed: false,
      });
      const dash = await http()
        .get(`${API}/dashboard/student`)
        .set(as('leila'))
        .expect(200);
      expect(dash.body).toMatchObject({
        state: 'SETUP_IN_PROGRESS',
        setup: { step: 'TEAM', completed: false },
        viewer: { isLeader: true, teamRole: 'LEADER' },
      });
    });

    it('a student without a project gets the NO_PROJECT empty state', async () => {
      const dash = await http()
        .get(`${API}/dashboard/student`)
        .set(as('sara'))
        .expect(200);
      expect(dash.body).toMatchObject({
        state: 'NO_PROJECT',
        hasProject: false,
        project: null,
      });
    });

    it('the leader can leave and resume the setup at any step', async () => {
      const res = await http()
        .patch(`${API}/projects/${p.projectId}/setup`)
        .set(as('leila'))
        .send({ step: 'SUPERVISOR' })
        .expect(200);
      expect(res.body.project.setup.step).toBe('SUPERVISOR');
      await http()
        .patch(`${API}/projects/${p.projectId}/setup`)
        .set(as('leila'))
        .send({ step: 'COMPLETED' })
        .expect(400);
      const ws = await http()
        .get(`${API}/projects/me`)
        .set(as('leila'))
        .expect(200);
      expect(ws.body.project.setup.step).toBe('SUPERVISOR');
    });
  });

  // ==================================================================
  describe('Team invitations by studentNumber (leader only)', () => {
    let invitationId = '';

    it('leader invites by studentNumber; the invitee is notified', async () => {
      const res = await http()
        .post(`${API}/teams/${p.teamId}/student-invitations`)
        .set(as('leila'))
        .send({ studentNumber: 's2026-002', message: 'Join us!' })
        .expect(201);
      invitationId = res.body.id;
      expect(res.body).toMatchObject({ status: 'PENDING' });
      expect(JSON.stringify(res.body)).not.toContain('noor@uni.test');
      expect(notificationsOf('noor', 'TEAM_INVITATION')).toHaveLength(1);
      const dup = await http()
        .post(`${API}/teams/${p.teamId}/student-invitations`)
        .set(as('leila'))
        .send({ studentNumber: 'S2026-002' })
        .expect(409);
      expect(dup.body.code).toBe('INVITATION_ALREADY_PENDING');
      const self = await http()
        .post(`${API}/teams/${p.teamId}/student-invitations`)
        .set(as('leila'))
        .send({ studentNumber: 'S2026-001' })
        .expect(400);
      expect(self.body.code).toBe('CANNOT_INVITE_YOURSELF');
    });

    it('the invitee sees it, accepts and joins as MEMBER; the leader is notified', async () => {
      const incoming = await http()
        .get(`${API}/team-invitations/incoming`)
        .set(as('noor'))
        .expect(200);
      expect(incoming.body.map((i: any) => i.id)).toContain(invitationId);
      await http()
        .post(`${API}/team-invitations/${invitationId}/accept`)
        .set(as('omar'))
        .expect(404);
      await http()
        .post(`${API}/team-invitations/${invitationId}/accept`)
        .set(as('noor'))
        .expect(200);
      const members = await http()
        .get(`${API}/teams/${p.teamId}/members`)
        .set(as('leila'))
        .expect(200);
      expect(
        members.body.find((m: any) => m.userId === ids.noor).teamRole,
      ).toBe('MEMBER');
      expect(
        notificationsOf('leila', 'TEAM_INVITATION').length,
      ).toBeGreaterThan(0);
    });

    it('a MEMBER cannot invite, manage the team, read the invite link or change the leader', async () => {
      const inv = await http()
        .post(`${API}/teams/${p.teamId}/student-invitations`)
        .set(as('noor'))
        .send({ studentNumber: 'S2026-003' })
        .expect(403);
      expect(inv.body.code).toBe('NOT_TEAM_LEADER');
      const attempts = [
        () => http().get(`${API}/teams/${p.teamId}/invitation`).set(as('noor')),
        () =>
          http()
            .patch(`${API}/teams/${p.teamId}`)
            .set(as('noor'))
            .send({ name: 'Renamed' }),
        () =>
          http()
            .patch(`${API}/teams/${p.teamId}/leader`)
            .set(as('noor'))
            .send({ userId: ids.noor }),
        () =>
          http()
            .delete(`${API}/teams/${p.teamId}/members/${ids.leila}`)
            .set(as('noor')),
      ];
      for (const attempt of attempts) {
        const res = await attempt().expect(403);
        expect(res.body.code).toBe('NOT_TEAM_LEADER');
      }
      const ws = await http()
        .get(`${API}/projects/${p.projectId}`)
        .set(as('noor'))
        .expect(200);
      expect(ws.body.invitation).toBeNull();
      expect(ws.body.viewer).toMatchObject({
        isLeader: false,
        teamRole: 'MEMBER',
      });
    });

    it('omar joins with the invite link (kept from earlier stages); erin declines an invitation', async () => {
      await http()
        .post(`${API}/teams/join`)
        .set(as('omar'))
        .send({ code: p.inviteCode })
        .expect(200);
      const inv = await http()
        .post(`${API}/teams/${p.teamId}/student-invitations`)
        .set(as('leila'))
        .send({ studentNumber: 'S2026-005' })
        .expect(201);
      const dash = await http()
        .get(`${API}/dashboard/student`)
        .set(as('erin'))
        .expect(200);
      expect(dash.body.pendingTeamInvitations).toBe(1);
      const declined = await http()
        .post(`${API}/team-invitations/${inv.body.id}/decline`)
        .set(as('erin'))
        .expect(200);
      expect(declined.body.status).toBe('DECLINED');
      const again = await http()
        .post(`${API}/team-invitations/${inv.body.id}/accept`)
        .set(as('erin'))
        .expect(409);
      expect(again.body.code).toBe('INVITATION_NOT_PENDING');
    });
  });

  // ==================================================================
  describe('Supervisor invitation (leader only, separate from the team)', () => {
    it('members cannot request a supervisor; the leader can; the supervisor is notified', async () => {
      const denied = await http()
        .post(`${API}/projects/${p.projectId}/supervision-requests`)
        .set(as('noor'))
        .send({ supervisorEmail: 'supA@uni.test' })
        .expect(403);
      expect(denied.body.code).toBe('NOT_TEAM_LEADER');
      const req = await http()
        .post(`${API}/projects/${p.projectId}/supervision-requests`)
        .set(as('leila'))
        .send({ supervisorEmail: 'supA@uni.test' })
        .expect(201);
      expect(notificationsOf('supA', 'SUPERVISION_REQUESTED')).toHaveLength(1);
      await http()
        .post(`${API}/supervision-requests/${req.body.id}/accept`)
        .set(as('supA'))
        .send({})
        .expect(200);
      for (const k of ['leila', 'noor', 'omar']) {
        expect(notificationsOf(k, 'SUPERVISION_RESPONDED')).toHaveLength(1);
      }
    });

    it('the supervisor belongs to the project, not to the team', async () => {
      const ws = await http()
        .get(`${API}/projects/${p.projectId}`)
        .set(as('supA'))
        .expect(200);
      expect(ws.body.supervisors.map((s: any) => s.userId)).toEqual([ids.supA]);
      expect(ws.body.team.members.map((m: any) => m.userId)).not.toContain(
        ids.supA,
      );
      expect(ws.body.viewer).toMatchObject({
        isSupervisor: true,
        isLeader: false,
      });
      expect(db.teamMember.rows.some((m: any) => m.userId === ids.supA)).toBe(
        false,
      );
      // a supervisor does not manage the team
      await http()
        .post(`${API}/teams/${p.teamId}/student-invitations`)
        .set(as('supA'))
        .send({ studentNumber: 'S2026-004' })
        .expect(403);
    });
  });

  // ==================================================================
  describe('Project details & setup completion', () => {
    it('only the leader edits the project details', async () => {
      const body = {
        overview: 'Indoor navigation for the campus with accessible routes.',
        objectives: ['Map all buildings', 'Accessible routing', 'Mobile app'],
        category: 'TECHNOLOGY',
        origin: 'NEW',
        expectedCompletionDate: '2027-05-30',
      };
      const denied = await http()
        .patch(`${API}/projects/${p.projectId}`)
        .set(as('noor'))
        .send(body)
        .expect(403);
      expect(denied.body.code).toBe('NOT_TEAM_LEADER');
      await http()
        .patch(`${API}/projects/${p.projectId}`)
        .set(as('supA'))
        .send(body)
        .expect(403);
      await http()
        .patch(`${API}/projects/${p.projectId}`)
        .set(as('leila'))
        .send({ ...body, category: 'SPACE' })
        .expect(400);
      const res = await http()
        .patch(`${API}/projects/${p.projectId}`)
        .set(as('leila'))
        .send(body)
        .expect(200);
      expect(res.body.project).toMatchObject({
        overview: body.overview,
        objectives: body.objectives,
        category: 'TECHNOLOGY',
        origin: 'NEW',
      });
      expect(res.body.project.expectedCompletionDate).toBe(
        '2027-05-30T00:00:00.000Z',
      );
      expect(res.body.leader).toMatchObject({ id: ids.leila });
    });

    it('completion is refused (422) while requirements are missing; members cannot complete', async () => {
      await http()
        .post(`${API}/projects/${p.projectId}/setup/complete`)
        .set(as('noor'))
        .expect(403);
      const res = await http()
        .post(`${API}/projects/${p.projectId}/setup/complete`)
        .set(as('leila'))
        .expect(422);
      expect(res.body).toMatchObject({
        code: 'PROJECT_SETUP_INCOMPLETE',
        details: {
          missingRequirements: [
            'PROJECT_DESCRIPTION_REQUIRED',
            'PROJECT_START_DATE_REQUIRED',
            'HANDBOOK_REQUIRED',
          ],
        },
      });
      // the frontend cannot mark the project complete itself
      await http()
        .patch(`${API}/projects/${p.projectId}`)
        .set(as('leila'))
        .send({
          setupStep: 'COMPLETED',
          setupCompletedAt: new Date().toISOString(),
        })
        .expect(400);
      await http()
        .patch(`${API}/projects/${p.projectId}/setup`)
        .set(as('leila'))
        .send({ step: 'COMPLETED' })
        .expect(400);
      const setup = await http()
        .get(`${API}/projects/${p.projectId}/setup`)
        .set(as('supA'))
        .expect(200);
      expect(setup.body).toMatchObject({
        completed: false,
        readiness: {
          canComplete: false,
          supervisorRequestStatus: 'ACCEPTED',
          handbookState: 'NONE',
        },
      });
    });
  });

  // ==================================================================
  describe('Project handbook', () => {
    it('access is protected: outsiders 403; members and supervisors read; only the leader uploads', async () => {
      await http()
        .get(`${API}/projects/${p.projectId}/handbook`)
        .set(as('erin'))
        .expect(403);
      await http().get(`${API}/projects/${p.projectId}/handbook`).expect(401);
      const member = await http()
        .get(`${API}/projects/${p.projectId}/handbook`)
        .set(as('noor'))
        .expect(200);
      expect(member.body).toMatchObject({
        state: 'NONE',
        canUpload: false,
        active: null,
      });
      const sup = await http()
        .get(`${API}/projects/${p.projectId}/handbook`)
        .set(as('supA'))
        .expect(200);
      expect(sup.body.canUpload).toBe(false);
      const denied = await http()
        .put(`${API}/projects/${p.projectId}/handbook`)
        .set(as('noor'))
        .attach('file', HANDBOOK_PDF, {
          filename: 'handbook.pdf',
          contentType: 'application/pdf',
        })
        .expect(403);
      expect(denied.body.code).toBe('NOT_TEAM_LEADER');
      await http()
        .put(`${API}/projects/${p.projectId}/handbook`)
        .set(as('supA'))
        .attach('file', HANDBOOK_PDF, {
          filename: 'handbook.pdf',
          contentType: 'application/pdf',
        })
        .expect(403);
      const notPdf = await http()
        .put(`${API}/projects/${p.projectId}/handbook`)
        .set(as('leila'))
        .attach('file', Buffer.from('hello'), {
          filename: 'x.pdf',
          contentType: 'application/pdf',
        })
        .expect(400);
      expect(notPdf.body.code).toBe('HANDBOOK_NOT_PDF');
    });

    it('the leader uploads: 202 PROCESSING, then READY in the background (no AI quota used)', async () => {
      const aiCalls = ai.requests.length;
      const res = await http()
        .put(`${API}/projects/${p.projectId}/handbook`)
        .set(as('leila'))
        .field('title', 'GP Handbook 2026')
        .attach('file', HANDBOOK_PDF, {
          filename: 'handbook.pdf',
          contentType: 'application/pdf',
        })
        .expect(202);
      expect(res.body).toMatchObject({
        state: 'PROCESSING',
        latest: { version: 1, status: 'PROCESSING' },
        canUpload: true,
      });
      await handbooks.whenIdle();
      const state = await http()
        .get(`${API}/projects/${p.projectId}/handbook`)
        .set(as('noor'))
        .expect(200);
      expect(state.body).toMatchObject({
        state: 'READY',
        active: {
          version: 1,
          status: 'READY',
          isActive: true,
          title: 'GP Handbook 2026',
        },
      });
      expect(state.body.active.sectionCount).toBeGreaterThan(0);
      expect(JSON.stringify(state.body)).not.toContain('extractedText');
      expect(ai.requests.length).toBe(aiCalls);
      expect(notificationsOf('leila', 'HANDBOOK_PROCESSED')).toHaveLength(1);
      const file = await http()
        .get(`${API}/projects/${p.projectId}/handbook/file`)
        .set(as('supA'))
        .expect(200);
      expect(file.body.fileName).toBe('handbook.pdf');
      expect(storage.objects.size).toBeGreaterThan(0);
      const limits = await http()
        .get(`${API}/ai-support/limits?projectId=${p.projectId}`)
        .set(as('leila'))
        .expect(200);
      expect(limits.body).toMatchObject({
        countsHandbookProcessing: false,
        hourly: { used: 0, resetsAt: null },
      });
    });

    it('a failed replacement is FAILED with an error code; the previous version stays active', async () => {
      await http()
        .put(`${API}/projects/${p.projectId}/handbook`)
        .set(as('leila'))
        .attach('file', UNREADABLE_PDF, {
          filename: 'broken.pdf',
          contentType: 'application/pdf',
        })
        .expect(202);
      await handbooks.whenIdle();
      const state = await http()
        .get(`${API}/projects/${p.projectId}/handbook`)
        .set(as('leila'))
        .expect(200);
      expect(state.body.state).toBe('READY');
      expect(state.body.active.version).toBe(1);
      expect(state.body.latest).toMatchObject({ version: 2, status: 'FAILED' });
      expect(['HANDBOOK_UNREADABLE', 'HANDBOOK_NO_TEXT']).toContain(
        state.body.latest.errorCode,
      );
      expect(state.body.latest.errorMessage).toEqual(expect.any(String));
      const versions = await http()
        .get(`${API}/projects/${p.projectId}/handbook/versions`)
        .set(as('noor'))
        .expect(200);
      expect(versions.body.map((v: any) => v.version)).toEqual([2, 1]);
    });

    it('a PROCESSING upload interrupted by a restart becomes FAILED (never stuck)', async () => {
      await db.projectHandbook.create({
        data: {
          projectId: p.projectId,
          version: 3,
          status: 'PROCESSING',
          title: 'Stuck upload',
          fileName: 'stuck.pdf',
          fileSize: 10,
          storagePath: `handbooks/projects/${p.projectId}/stuck.pdf`,
          processingStartedAt: new Date(Date.now() - 11 * 60 * 1000),
        },
      });
      const state = await http()
        .get(`${API}/projects/${p.projectId}/handbook`)
        .set(as('noor'))
        .expect(200);
      expect(state.body.state).toBe('READY');
      expect(state.body.latest).toMatchObject({
        version: 3,
        status: 'FAILED',
        errorCode: 'HANDBOOK_PROCESSING_INTERRUPTED',
      });
    });
  });

  // ==================================================================
  describe('Complete project setup (all requirements met)', () => {
    it('after description, start date and a READY handbook, the leader completes it; idempotent; no tasks created', async () => {
      await http()
        .patch(`${API}/projects/${p.projectId}`)
        .set(as('leila'))
        .send({
          description: 'Campus indoor navigation graduation project',
          startDate: '2026-09-01',
        })
        .expect(200);
      const tasksBefore = db.task.rows.length;
      const done = await http()
        .post(`${API}/projects/${p.projectId}/setup/complete`)
        .set(as('leila'))
        .expect(200);
      expect(done.body.setupReadiness).toMatchObject({
        canComplete: true,
        missingRequirements: [],
        completed: true,
      });
      expect(db.task.rows.length).toBe(tasksBefore);
      expect(done.body.project.setup).toMatchObject({
        step: 'COMPLETED',
        completed: true,
      });
      await http()
        .post(`${API}/projects/${p.projectId}/setup/complete`)
        .set(as('leila'))
        .expect(200);
      const back = await http()
        .patch(`${API}/projects/${p.projectId}/setup`)
        .set(as('leila'))
        .send({ step: 'TEAM' })
        .expect(409);
      expect(back.body.code).toBe('SETUP_ALREADY_COMPLETED');
      const dash = await http()
        .get(`${API}/dashboard/student`)
        .set(as('noor'))
        .expect(200);
      expect(dash.body).toMatchObject({
        state: 'EMPTY_PROJECT',
        viewer: { isLeader: false, teamRole: 'MEMBER' },
        project: {
          category: 'TECHNOLOGY',
          leader: { id: ids.leila },
          supervisor: { id: ids.supA },
        },
        handbook: { state: 'READY' },
      });
    });

    it('milestones (stages) have an order and are leader-managed', async () => {
      await http()
        .post(`${API}/milestones`)
        .set(as('noor'))
        .send({ projectId: p.projectId, title: 'Nope', dueDate: inDays(5) })
        .expect(403);
      for (const [title, order, due] of [
        ['Implementation', 2, 60],
        ['Proposal', 1, 20],
      ] as const) {
        await http()
          .post(`${API}/milestones`)
          .set(as('leila'))
          .send({ projectId: p.projectId, title, order, dueDate: inDays(due) })
          .expect(201);
      }
      const ws = await http()
        .get(`${API}/projects/${p.projectId}`)
        .set(as('supA'))
        .expect(200);
      expect(ws.body.stages.map((s: any) => [s.title, s.order])).toEqual([
        ['Proposal', 1],
        ['Implementation', 2],
      ]);
    });
  });

  // ==================================================================
  describe('AI: project-aware guidance, conversations and task suggestions', () => {
    let memberRequestId = '';
    let leaderRequestId = '';
    let conversationId = '';
    const suggestions = {
      summary: 'Plan the implementation stage.',
      answer: '',
      recommendations: [],
      nextSteps: [],
      taskSuggestions: [
        {
          title: 'Build indoor map data model',
          description: 'Rooms, corridors and accessible paths.',
          priority: 'HIGH',
          estimatedDays: 6,
          milestone: 'implementation',
        },
        {
          title: 'Design routing API',
          description: 'Shortest accessible path.',
          priority: 'MEDIUM',
          estimatedDays: 4,
          milestone: '',
        },
        {
          title: 'Usability study',
          description: 'Five students test the app.',
          priority: 'LOW',
          estimatedDays: 3,
          milestone: 'Unknown stage',
        },
      ],
      milestoneSuggestions: [],
      handbookReferences: [],
      risks: [],
      confidence: 'MEDIUM',
    };

    it('the prompt is project-aware and uses the project handbook', async () => {
      const res = await http()
        .post(`${API}/ai-support/requests`)
        .set(as('noor'))
        .send({ projectId: p.projectId, kind: 'HANDBOOK_GUIDANCE' })
        .expect(201);
      expect(res.body.handbook).toMatchObject({
        used: true,
        source: 'PROJECT',
        title: 'GP Handbook 2026',
      });
      const prompt = ai.lastPrompt;
      expect(prompt).toContain('Overview: Indoor navigation for the campus');
      expect(prompt).toContain('- Accessible routing');
      expect(prompt).toContain('Category: TECHNOLOGY; origin: NEW');
      expect(prompt).toContain('Team load (open tasks): Leader=0');
      expect(prompt).not.toContain('noor@uni.test');
      expect(prompt).not.toContain('Noor');
      const hb = await http()
        .get(`${API}/ai-support/handbook?projectId=${p.projectId}`)
        .set(as('noor'))
        .expect(200);
      expect(hb.body).toMatchObject({ available: true, source: 'PROJECT' });
    });

    it('TASK_BREAKDOWN returns structured suggestions and creates no task', async () => {
      const tasksBefore = db.task.rows.length;
      ai.nextJson(suggestions);
      const res = await http()
        .post(`${API}/ai-support/requests`)
        .set(as('noor'))
        .send({ projectId: p.projectId, kind: 'TASK_BREAKDOWN' })
        .expect(201);
      memberRequestId = res.body.id;
      expect(res.body.guidance.taskSuggestions).toEqual([
        expect.objectContaining({
          id: 't1',
          title: 'Build indoor map data model',
          priority: 'HIGH',
          estimatedDays: 6,
          appliedTaskId: null,
        }),
        expect.objectContaining({ id: 't2', priority: 'MEDIUM' }),
        expect.objectContaining({ id: 't3', priority: 'LOW' }),
      ]);
      expect(db.task.rows.length).toBe(tasksBefore);
    });

    it('non-leaders cannot apply suggestions', async () => {
      const body = {
        aiRequestId: memberRequestId,
        items: [{ suggestionId: 't1' }],
      };
      const member = await http()
        .post(`${API}/projects/${p.projectId}/ai-task-suggestions/apply`)
        .set(as('noor'))
        .send(body)
        .expect(403);
      expect(member.body.code).toBe('NOT_TEAM_LEADER');
      await http()
        .post(`${API}/projects/${p.projectId}/ai-task-suggestions/apply`)
        .set(as('supA'))
        .send(body)
        .expect(403);
      await http()
        .post(`${API}/projects/${p.projectId}/ai-task-suggestions/apply`)
        .set(as('erin'))
        .send(body)
        .expect(403);
      // the leader cannot apply someone else's private answer
      const other = await http()
        .post(`${API}/projects/${p.projectId}/ai-task-suggestions/apply`)
        .set(as('leila'))
        .send(body)
        .expect(404);
      expect(other.body.code).toBe('AI_REQUEST_NOT_FOUND');
    });

    it('the leader applies selected, edited suggestions: real tasks, validated, idempotent', async () => {
      // an existing manual task with the same title as suggestion t2
      await http()
        .post(`${API}/tasks`)
        .set(as('leila'))
        .send({ projectId: p.projectId, title: 'design routing API' })
        .expect(201);
      ai.nextJson(suggestions);
      const req = await http()
        .post(`${API}/ai-support/requests`)
        .set(as('leila'))
        .send({ projectId: p.projectId, kind: 'TASK_BREAKDOWN' })
        .expect(201);
      leaderRequestId = req.body.id;

      const bad = await http()
        .post(`${API}/projects/${p.projectId}/ai-task-suggestions/apply`)
        .set(as('leila'))
        .send({ aiRequestId: leaderRequestId, items: [{ suggestionId: 't9' }] })
        .expect(400);
      expect(bad.body.code).toBe('AI_SUGGESTION_NOT_FOUND');
      const outsider = await http()
        .post(`${API}/projects/${p.projectId}/ai-task-suggestions/apply`)
        .set(as('leila'))
        .send({
          aiRequestId: leaderRequestId,
          items: [{ suggestionId: 't1', assignedStudentId: ids.erin }],
        })
        .expect(400);
      expect(outsider.body.code).toBe('ASSIGNEE_NOT_IN_TEAM');
      await http()
        .post(`${API}/projects/${p.projectId}/ai-task-suggestions/apply`)
        .set(as('leila'))
        .send({
          aiRequestId: leaderRequestId,
          items: [{ suggestionId: 't1', priority: 'URGENT' }],
        })
        .expect(400);

      const res = await http()
        .post(`${API}/projects/${p.projectId}/ai-task-suggestions/apply`)
        .set(as('leila'))
        .send({
          aiRequestId: leaderRequestId,
          items: [
            {
              suggestionId: 't1',
              title: 'Build the indoor map data model',
              assignedStudentId: ids.noor,
              dueDate: inDays(14),
            },
            { suggestionId: 't2' },
            { suggestionId: 't3', estimatedDays: 2 },
          ],
        })
        .expect(200);
      expect(res.body.created).toHaveLength(2);
      const [t1, t3] = res.body.created;
      expect(t1).toMatchObject({
        title: 'Build the indoor map data model',
        source: 'AI_SUGGESTION',
        priority: 'HIGH',
        estimatedDays: 6,
        status: 'TODO',
        assignedStudentId: ids.noor,
        milestone: { title: 'Implementation' }, // matched by title, case-insensitive
        createdBy: { id: ids.leila },
      });
      expect(t3).toMatchObject({
        title: 'Usability study',
        estimatedDays: 2,
        milestone: null,
        assignedStudentId: null,
      });
      expect(res.body.skipped).toEqual([
        expect.objectContaining({
          suggestionId: 't2',
          reason: 'DUPLICATE_TITLE',
        }),
      ]);
      expect(notificationsOf('noor', 'TASK_ASSIGNED')).toHaveLength(1);

      const again = await http()
        .post(`${API}/projects/${p.projectId}/ai-task-suggestions/apply`)
        .set(as('leila'))
        .send({ aiRequestId: leaderRequestId, items: [{ suggestionId: 't1' }] })
        .expect(200);
      expect(again.body).toMatchObject({
        created: [],
        alreadyApplied: [{ suggestionId: 't1', taskId: t1.id }],
      });
      const view = await http()
        .get(`${API}/ai-support/requests/${leaderRequestId}`)
        .set(as('leila'))
        .expect(200);
      expect(
        view.body.guidance.taskSuggestions.map((s: any) => s.appliedTaskId),
      ).toEqual([t1.id, null, t3.id]);
      ids.taskT1 = t1.id;
      ids.taskT3 = t3.id;
    });

    it('applied tasks behave like manual ones: leader assigns, member updates own status only', async () => {
      const assign = await http()
        .patch(`${API}/tasks/${ids.taskT3}`)
        .set(as('leila'))
        .send({ assignedStudentId: ids.omar, dueDate: inDays(-1) })
        .expect(200);
      expect(assign.body.assignedStudentId).toBe(ids.omar);
      expect(notificationsOf('omar', 'TASK_ASSIGNED')).toHaveLength(1);
      await http()
        .patch(`${API}/tasks/${ids.taskT1}`)
        .set(as('noor'))
        .send({ status: 'IN_PROGRESS' })
        .expect(200);
      const reassign = await http()
        .patch(`${API}/tasks/${ids.taskT1}`)
        .set(as('noor'))
        .send({ assignedStudentId: ids.omar })
        .expect(403);
      expect(reassign.body.code).toBe('TASK_STATUS_ONLY');
      await http()
        .patch(`${API}/tasks/${ids.taskT3}`)
        .set(as('noor'))
        .send({ status: 'COMPLETED' })
        .expect(403);
      await http()
        .patch(`${API}/tasks/${ids.taskT1}`)
        .set(as('supA'))
        .send({ status: 'COMPLETED' })
        .expect(403);
      const sup = await http()
        .get(`${API}/tasks?projectId=${p.projectId}`)
        .set(as('supA'))
        .expect(200);
      expect(sup.body.meta.total).toBe(3);
      const mine = await http()
        .get(`${API}/tasks?assignedStudentId=me`)
        .set(as('noor'))
        .expect(200);
      expect(mine.body.items.map((t: any) => t.id)).toEqual([ids.taskT1]);
    });

    it('side chat: create, continue with history, list and open; private to the owner', async () => {
      const created = await http()
        .post(`${API}/ai-support/conversations`)
        .set(as('noor'))
        .send({ projectId: p.projectId })
        .expect(201);
      conversationId = created.body.id;
      expect(created.body).toMatchObject({
        title: 'New conversation',
        messageCount: 0,
      });
      ai.nextJson({
        ...suggestions,
        answer: 'Start with the data model.',
        taskSuggestions: [],
      });
      const first = await http()
        .post(`${API}/ai-support/conversations/${conversationId}/messages`)
        .set(as('noor'))
        .send({ content: 'Where should I start this week?' })
        .expect(201);
      expect(first.body.assistantMessage).toMatchObject({
        role: 'ASSISTANT',
        content: 'Start with the data model.',
      });
      expect(first.body.conversation).toMatchObject({
        title: 'Where should I start this week?',
        messageCount: 2,
      });
      await http()
        .post(`${API}/ai-support/conversations/${conversationId}/messages`)
        .set(as('noor'))
        .send({ content: 'And after that?' })
        .expect(201);
      expect(ai.lastPrompt).toContain('<conversation>');
      expect(ai.lastPrompt).toContain(
        'Student: Where should I start this week?',
      );
      expect(ai.lastPrompt).toContain('Assistant: Start with the data model.');

      // failed AI call: nothing saved in the conversation
      ai.nextText('not json');
      await http()
        .post(`${API}/ai-support/conversations/${conversationId}/messages`)
        .set(as('noor'))
        .send({ content: 'One more question' })
        .expect(502);

      const opened = await http()
        .get(`${API}/ai-support/conversations/${conversationId}`)
        .set(as('noor'))
        .expect(200);
      expect(opened.body.messages.map((m: any) => m.role)).toEqual([
        'USER',
        'ASSISTANT',
        'USER',
        'ASSISTANT',
      ]);
      const list = await http()
        .get(`${API}/ai-support/conversations?projectId=${p.projectId}`)
        .set(as('noor'))
        .expect(200);
      expect(list.body.items.map((c: any) => c.id)).toEqual([conversationId]);
      for (const who of ['leila', 'supA', 'erin']) {
        await http()
          .get(`${API}/ai-support/conversations/${conversationId}`)
          .set(as(who))
          .expect(404);
      }
      await http()
        .post(`${API}/ai-support/conversations`)
        .set(as('erin'))
        .send({ projectId: p.projectId })
        .expect(403);
    });

    it('usage exposes remaining quota and reset times', async () => {
      const res = await http()
        .get(`${API}/ai-support/limits?projectId=${p.projectId}`)
        .set(as('noor'))
        .expect(200);
      expect(res.body.hourly.used).toBeGreaterThan(0);
      expect(res.body.hourly.remaining).toBe(
        res.body.hourly.limit - res.body.hourly.used,
      );
      expect(new Date(res.body.hourly.resetsAt).getTime()).toBeGreaterThan(
        Date.now(),
      );
      expect(res.body.daily.window).toBe('24h');
    });
  });

  // ==================================================================
  describe('Regression: documents, feedback, meetings, dashboard, notifications', () => {
    let docId = '';

    it('documents: members upload; only the uploader or the leader may change/delete', async () => {
      const up = await http()
        .post(`${API}/documents/upload`)
        .set(as('noor'))
        .field('projectId', p.projectId)
        .field('title', 'Chapter 1')
        .field('submitForReview', 'true') // sent to the supervisor (review workflow)
        .attach('file', DOC_PDF, {
          filename: 'c1.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);
      docId = up.body.id;
      const del = await http()
        .delete(`${API}/documents/${docId}`)
        .set(as('omar'))
        .expect(403);
      expect(del.body.code).toBe('DOCUMENT_NOT_OWNER');
      await http()
        .patch(`${API}/documents/${docId}`)
        .set(as('omar'))
        .send({ title: 'Hijacked' })
        .expect(403);
      await http()
        .patch(`${API}/documents/${docId}`)
        .set(as('noor'))
        .send({ title: 'Chapter 1: Introduction' })
        .expect(200);
      expect(notificationsOf('supA', 'DOCUMENT_SUBMITTED')).toHaveLength(1);
    });

    it('feedback: the supervisor reviews; students are notified and see it on the dashboard', async () => {
      await http()
        .post(`${API}/feedback`)
        .set(as('supA'))
        .send({
          documentId: docId,
          comment: 'Clarify the scope',
          status: 'CHANGES_REQUESTED',
        })
        .expect(201);
      expect(
        notificationsOf('noor').filter((n: any) =>
          ['FEEDBACK_RECEIVED', 'SUBMISSION_STATUS_CHANGED'].includes(n.type),
        ).length,
      ).toBeGreaterThan(0);
      await http()
        .post(`${API}/feedback`)
        .set(as('noor'))
        .send({ projectId: p.projectId, comment: 'Self review' })
        .expect(403);
    });

    it('meetings: the supervisor schedules one; it appears on the dashboard and members are notified', async () => {
      const res = await http()
        .post(`${API}/meetings`)
        .set(as('supA'))
        .send({
          projectId: p.projectId,
          title: 'Weekly check-in',
          scheduledAt: inDays(2),
          durationMinutes: 30,
        })
        .expect(201);
      expect(res.body.title).toBe('Weekly check-in');
      expect(
        notificationsOf('noor', 'MEETING_INVITATION').length,
      ).toBeGreaterThan(0);
    });

    it('student dashboard: project, progress, my tasks, overdue, deadlines, meetings, files, feedback, handbook', async () => {
      const dash = await http()
        .get(`${API}/dashboard/student?days=30`)
        .set(as('omar'))
        .expect(200);
      expect(dash.body).toMatchObject({
        state: 'ACTIVE',
        hasProject: true,
        viewer: { isLeader: false, teamRole: 'MEMBER' },
        setup: { completed: true },
        handbook: { state: 'READY', version: 1 },
        project: { supervisor: { id: ids.supA }, leader: { id: ids.leila } },
        myTasks: { open: 1, overdue: 1 },
      });
      expect(dash.body.myTasks.items[0]).toMatchObject({
        id: ids.taskT3,
        isOverdue: true,
      });
      expect(dash.body.overdueTasks.map((t: any) => t.id)).toContain(
        ids.taskT3,
      );
      expect(dash.body.upcomingMeetings).toHaveLength(1);
      expect(dash.body.latestDocuments[0]).toMatchObject({ id: docId });
      expect(dash.body.latestFeedback.length).toBeGreaterThan(0);
      expect(dash.body.unreadNotifications).toBeGreaterThan(0);
      expect(dash.body.upcomingDeadlines.map((d: any) => d.title)).toContain(
        'Proposal',
      );
      // dates are ISO strings everywhere (frontend calendar)
      expect(dash.body.upcomingMeetings[0].scheduledAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T/,
      );
    });

    it('notifications are listed for the user, never duplicated, and can be marked read', async () => {
      const list = await http()
        .get(`${API}/notifications?limit=50`)
        .set(as('noor'))
        .expect(200);
      const keys = list.body.items
        .map((n: any) => n.type + JSON.stringify(n.data))
        .filter(Boolean);
      expect(new Set(keys).size).toBe(keys.length);
      expect(list.body.items.map((n: any) => n.type)).toEqual(
        expect.arrayContaining([
          'TEAM_INVITATION',
          'SUPERVISION_RESPONDED',
          'TASK_ASSIGNED',
          'MEETING_INVITATION',
        ]),
      );
      await http()
        .patch(`${API}/notifications/read-all`)
        .set(as('noor'))
        .expect(200);
      const count = await http()
        .get(`${API}/notifications/unread-count`)
        .set(as('noor'))
        .expect(200);
      expect(count.body.unreadCount).toBe(0);
    });

    it('a supervisor monitors but cannot manage: tasks, milestones, team, handbook, AI apply', async () => {
      const sup = as('supA');
      await http()
        .post(`${API}/tasks`)
        .set(sup)
        .send({ projectId: p.projectId, title: 'Sup task' })
        .expect(403);
      await http()
        .post(`${API}/milestones`)
        .set(sup)
        .send({ projectId: p.projectId, title: 'Sup', dueDate: inDays(9) })
        .expect(403);
      await http()
        .delete(`${API}/teams/${p.teamId}/members/${ids.omar}`)
        .set(sup)
        .expect(403);
      for (const path of [
        `/projects/${p.projectId}/handbook/versions`,
        `/milestones?projectId=${p.projectId}`,
        `/meetings?projectId=${p.projectId}`,
        `/documents?projectId=${p.projectId}`,
        `/projects/${p.projectId}/progress`,
      ]) {
        await http().get(`${API}${path}`).set(sup).expect(200);
      }
      const dash = await http()
        .get(`${API}/dashboard/supervisor`)
        .set(sup)
        .expect(200);
      expect(JSON.stringify(dash.body)).toContain(p.projectId);
    });
  });

  // ==================================================================
  it('Swagger documents the P16 routes; every non-public operation is secured', () => {
    const doc = createSwaggerDocument(app);
    for (const path of [
      '/api/v1/auth/verify-email',
      '/api/v1/auth/verify-email/code',
      '/api/v1/auth/verify-email/resend',
      '/api/v1/auth/verify-email/change-email',
      '/api/v1/auth/resend-verification',
      '/api/v1/auth/forgot-password',
      '/api/v1/auth/reset-password',
      '/api/v1/users/me/onboarding/complete',
      '/api/v1/students/search',
      '/api/v1/teams/{id}/student-invitations',
      '/api/v1/team-invitations/{invitationId}/accept',
      '/api/v1/projects/{id}/setup',
      '/api/v1/projects/{id}/setup/complete',
      '/api/v1/projects/{projectId}/handbook',
      '/api/v1/projects/{projectId}/handbook/versions',
      '/api/v1/ai-support/conversations',
      '/api/v1/ai-support/conversations/{id}/messages',
      '/api/v1/projects/{projectId}/ai-task-suggestions/apply',
    ]) {
      expect(doc.paths).toHaveProperty([path]);
    }
    const tags = (doc.tags ?? []).map((t) => t.name);
    for (const t of [
      'AI Conversations',
      'AI Task Suggestions',
      'Project Handbook',
      'Users',
    ]) {
      expect(tags).toContain(t);
    }
  });
});
