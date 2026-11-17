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
import { FakeEmailSender } from './testing/fake-email-sender';
import { EMAIL_SENDER } from '@/integrations/email/email.sender';
import { SupervisorAccountsService } from '@modules/auth/supervisor-accounts.service';
import { verificationCodeIn } from '@/testing/verification-code';

/**
 * Student university identity on the real AppModule (in-memory store, fake e-mail sender).
 *
 * A STUDENT needs a student number OR a VERIFIED university e-mail (not both). The account
 * e-mail stays the sign-in/recovery/notification address. Students without either are
 * profile-incomplete: they cannot create a project, lead/manage a team or complete setup.
 */
const API = '/api/v1';
const PASSWORD = 'Password123';

describe('Student university identity (AppModule integration)', () => {
  let app: INestApplication;
  let db: InMemoryPrisma;
  let jwt: JwtService;
  const mail = new FakeEmailSender();
  let uniUM = ''; // e-mail domains configured: um.edu.sa
  let uniOther = ''; // no domains configured
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const as = (k: string) => ({ Authorization: `Bearer ${tokens[k]}` });
  const linksTo = (
    to: string,
    kind: 'verify-email' | 'verify-university-email' | 'activate-account',
  ) =>
    mail.sent
      .filter((m) => m.to === to)
      .map(
        (m) =>
          new RegExp(`/${kind}\\.html\\?token=([A-Za-z0-9_-]{43})`).exec(
            m.text,
          )?.[1],
      )
      .filter((t): t is string => !!t);
  const lastLink = (
    to: string,
    kind: 'verify-email' | 'verify-university-email',
  ) => linksTo(to, kind).pop() ?? null;
  /** P17: the latest verification code e-mailed to this address */
  const lastCode = (to: string) =>
    mail.sent
      .filter((m) => m.to === to)
      .map((m) => verificationCodeIn(m.text))
      .filter((c): c is string => !!c)
      .pop() ?? null;
  const me = async (k: string) =>
    (await http().get(`${API}/auth/me`).set(as(k)).expect(200)).body;

  let autoNumber = 0;
  /** New registrations need a student number: one is added unless the body sets the key. */
  const register = (body: Record<string, unknown>) =>
    http()
      .post(`${API}/auth/register`)
      .send({
        password: PASSWORD,
        role: 'STUDENT',
        universityId: uniUM,
        ...(!('studentNumber' in body) && {
          studentNumber: `AUTO-${++autoNumber}`,
        }),
        ...body,
      });
  /** Simulates an account from before this rule: no student number stored. */
  const dropStudentNumber = (k: string) => {
    db.user.rows.find((u: any) => u.id === ids[k])!.studentNumber = null;
  };
  const keep = (key: string, res: request.Response) => {
    tokens[key] = res.body.tokens.accessToken;
    ids[key] = res.body.user.id;
    return res.body.user;
  };

  beforeAll(async () => {
    db = createInMemoryPrisma();
    uniUM = (await db.university.create({
      data: {
        name: 'Almaarefa University',
        code: 'UM',
        emailDomains: ['um.edu.sa'],
      },
    }))!.id;
    uniOther = (await db.university.create({
      data: { name: 'Other University', code: 'OU' },
    }))!.id;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(db)
      .overrideProvider(EMAIL_SENDER)
      .useValue(mail)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    jwt = app.get(JwtService);
  });

  afterAll(async () => {
    await app?.close();
  });

  // ==================================================================
  describe('Registration', () => {
    it('a STUDENT without a student number is rejected; nothing is created', async () => {
      const res = await register({
        email: 'none@gmail.test',
        universityId: uniOther,
        studentNumber: undefined,
        accountEmailIsUniversityEmail: true,
      }).expect(400);
      expect(res.body.code).toBe('STUDENT_NUMBER_REQUIRED');
      expect(db.user.rows.some((u: any) => u.email === 'none@gmail.test')).toBe(
        false,
      );
    });

    it('a student number alone is not enough: a university e-mail is required', async () => {
      const res = await register({
        email: 'only.number@gmail.test',
        studentNumber: 'UM-9001',
      }).expect(400);
      expect(res.body.code).toBe('UNIVERSITY_EMAIL_REQUIRED');
      expect(res.body.details.allowedDomains).toEqual(['um.edu.sa']);
    });

    it('SUPERVISOR accounts: self-registration needs a university e-mail; an ADMIN can also create them', async () => {
      const personal = await register({
        email: 'sup@gmail.com',
        role: 'SUPERVISOR',
        studentNumber: undefined,
      }).expect(400);
      expect(personal.body.code).toBe('SUPERVISOR_UNIVERSITY_EMAIL_REQUIRED');
      const otherDomain = await register({
        email: 'sup@other-uni.edu',
        role: 'SUPERVISOR',
        studentNumber: undefined,
      }).expect(400);
      expect(otherDomain.body.code).toBe(
        'SUPERVISOR_UNIVERSITY_EMAIL_REQUIRED',
      );

      await app.get(SupervisorAccountsService).create({
        email: 'sup@um.edu.sa',
        firstName: 'Sup',
        universityId: uniUM,
      });
      const token = linksTo('sup@um.edu.sa', 'activate-account').pop()!;
      await http()
        .post(`${API}/auth/activate-account`)
        .send({ token, newPassword: PASSWORD })
        .expect(200);
      const ok = await http()
        .post(`${API}/auth/login`)
        .send({ email: 'sup@um.edu.sa', password: PASSWORD })
        .expect(200);
      const user = keep('sup', ok);
      expect(user).toMatchObject({
        role: 'SUPERVISOR',
        emailVerified: true,
        profileComplete: true,
        universityIdentity: { required: false, complete: true },
        universityEmail: null,
        pendingUniversityEmail: null,
      });
      // personal mailbox providers are refused for supervisors too
      await expect(
        app.get(SupervisorAccountsService).create({
          email: 'sup2@gmail.com',
          firstName: 'Sup',
          universityId: uniOther,
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('student number + separate university e-mail: identity complete at once; both addresses get a link', async () => {
      const res = await register({
        email: 'sami@gmail.test',
        firstName: 'Sami',
        lastName: 'Q',
        studentNumber: ' um-1001 ',
        universityEmail: 'sami.q@um.edu.sa',
      }).expect(201);
      const user = keep('sami', res);
      expect(user).toMatchObject({
        email: 'sami@gmail.test',
        studentNumber: 'UM-1001',
        profileComplete: true,
        emailVerified: false,
        universityIdentity: { complete: true, satisfiedBy: ['STUDENT_NUMBER'] },
      });
      expect(lastCode('sami@gmail.test')).not.toBeNull();
      expect(
        lastLink('sami.q@um.edu.sa', 'verify-university-email'),
      ).not.toBeNull();
    });

    it('an older account with only a pending university e-mail is incomplete until its link is used', async () => {
      const res = await register({
        email: 'hala@gmail.test',
        firstName: 'Hala',
        lastName: 'R',
        universityEmail: 'Hala.R@UM.edu.sa',
      }).expect(201);
      keep('hala', res);
      dropStudentNumber('hala'); // as accounts created before student numbers were required
      const user = await me('hala');
      expect(user).toMatchObject({
        profileComplete: false,
        universityEmail: null,
        pendingUniversityEmail: 'hala.r@um.edu.sa',
        universityIdentity: { complete: false, satisfiedBy: [] },
      });
      // two different mailboxes, two links
      expect(lastCode('hala@gmail.test')).not.toBeNull();
      expect(
        lastLink('hala.r@um.edu.sa', 'verify-university-email'),
      ).not.toBeNull();
    });

    it("the university e-mail must belong to the university's configured domains", async () => {
      const res = await register({
        email: 'x1@gmail.test',
        universityEmail: 'x1@gmail.test',
      }).expect(400);
      expect(res.body.code).toBe('UNIVERSITY_EMAIL_DOMAIN_MISMATCH');
      // a personal mailbox is never a university e-mail, even without configured domains
      const personal = await register({
        email: 'x2@gmail.com',
        universityId: uniOther,
        accountEmailIsUniversityEmail: true,
      }).expect(400);
      expect(personal.body.code).toBe('UNIVERSITY_EMAIL_DOMAIN_MISMATCH');
      expect(res.body.details.allowedDomains).toEqual(['um.edu.sa']);
    });

    it('account e-mail on a university domain (subdomains too) is the university e-mail: one address, one link', async () => {
      const before = mail.sent.length;
      const res = await register({
        email: 'ziad@student.um.edu.sa',
        firstName: 'Ziad',
      }).expect(201);
      const user = keep('ziad', res);
      expect(user.pendingUniversityEmail).toBe('ziad@student.um.edu.sa');
      expect(mail.sent.length).toBe(before + 1); // only the account verification e-mail
      await http()
        .post(`${API}/auth/verify-email/code`)
        .send({
          email: 'ziad@student.um.edu.sa',
          code: lastCode('ziad@student.um.edu.sa'),
        })
        .expect(200);
      expect(await me('ziad')).toMatchObject({
        emailVerified: true,
        universityEmail: 'ziad@student.um.edu.sa',
        pendingUniversityEmail: null,
        profileComplete: true,
        universityIdentity: {
          satisfiedBy: expect.arrayContaining(['UNIVERSITY_EMAIL']),
        },
      });
    });

    it('no domains configured: accountEmailIsUniversityEmail marks the account e-mail as the university e-mail', async () => {
      const res = await register({
        email: 'mona@other.edu',
        universityId: uniOther,
        accountEmailIsUniversityEmail: true,
      }).expect(201);
      keep('mona', res);
      expect(res.body.user.pendingUniversityEmail).toBe('mona@other.edu');
      expect(linksTo('mona@other.edu', 'verify-university-email')).toHaveLength(
        0,
      );
      // verifying the account e-mail verifies both
      await http()
        .post(`${API}/auth/verify-email/code`)
        .send({ email: 'mona@other.edu', code: lastCode('mona@other.edu') })
        .expect(200);
      expect((await me('mona')).profileComplete).toBe(true);

      const mismatch = await register({
        email: 'mo2@other.edu',
        universityId: uniOther,
        accountEmailIsUniversityEmail: true,
        universityEmail: 'other@other.edu',
      }).expect(400);
      expect(mismatch.body.code).toBe('UNIVERSITY_EMAIL_MISMATCH');
    });

    it('a university e-mail used by another account (as university or account e-mail) is refused', async () => {
      const a = await register({
        email: 'dup1@gmail.test',
        universityEmail: 'ziad@student.um.edu.sa',
      }).expect(409);
      expect(a.body.code).toBe('UNIVERSITY_EMAIL_TAKEN');
      const b = await register({
        email: 'dup2@gmail.test',
        universityEmail: 'sup@um.edu.sa', // the supervisor's account e-mail
      }).expect(409);
      expect(b.body.code).toBe('UNIVERSITY_EMAIL_TAKEN');
    });
  });

  // ==================================================================
  describe('Verifying a university e-mail', () => {
    it('unverified: cannot create a project and cannot be found by e-mail', async () => {
      const res = await http()
        .post(`${API}/projects`)
        .set(as('hala'))
        .send({ name: 'Hala project' })
        .expect(403);
      expect(res.body.code).toBe('UNIVERSITY_IDENTITY_REQUIRED');
      await http()
        .get(`${API}/students/search?universityEmail=hala.r@um.edu.sa`)
        .set(as('sami'))
        .expect(404);
    });

    it('resend cooldown; a newer link replaces the older one', async () => {
      const wait = await http()
        .post(`${API}/auth/university-email`)
        .set(as('hala'))
        .send({ universityEmail: 'hala.r@um.edu.sa' })
        .expect(429);
      expect(wait.body.code).toBe('VERIFICATION_RECENTLY_SENT');
      for (const t of db.authToken.rows as any[]) {
        if (t.userId === ids.hala) t.createdAt = new Date(Date.now() - 120_000);
      }
      const first = lastLink('hala.r@um.edu.sa', 'verify-university-email')!;
      const res = await http()
        .post(`${API}/auth/university-email`)
        .set(as('hala'))
        .send({ universityEmail: 'hala.r@um.edu.sa' })
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'PENDING_VERIFICATION',
        emailDelivery: 'ENABLED',
        universityIdentity: {
          complete: false,
          pendingUniversityEmail: 'hala.r@um.edu.sa',
        },
      });
      await http()
        .post(`${API}/auth/verify-university-email`)
        .send({ token: first })
        .expect(400);
    });

    it('the link verifies the university e-mail only; the account e-mail is unchanged', async () => {
      const token = lastLink('hala.r@um.edu.sa', 'verify-university-email')!;
      const res = await http()
        .post(`${API}/auth/verify-university-email`)
        .send({ token })
        .expect(200);
      expect(res.body).toMatchObject({
        universityEmailVerified: true,
        universityIdentity: {
          complete: true,
          universityEmail: 'hala.r@um.edu.sa',
        },
      });
      expect(await me('hala')).toMatchObject({
        email: 'hala@gmail.test',
        emailVerified: false,
        universityEmail: 'hala.r@um.edu.sa',
        pendingUniversityEmail: null,
        profileComplete: true,
      });
      const again = await http()
        .post(`${API}/auth/verify-university-email`)
        .send({ token })
        .expect(400);
      expect(again.body.code).toBe('VERIFICATION_TOKEN_INVALID');
    });

    it('request endpoint: students only, domain, conflicts, already verified, verified account e-mail at once', async () => {
      const sup = await http()
        .post(`${API}/auth/university-email`)
        .set(as('sup'))
        .send({ universityEmail: 'sup@um.edu.sa' })
        .expect(400);
      expect(sup.body.code).toBe('UNIVERSITY_EMAIL_NOT_ALLOWED');
      const domain = await http()
        .post(`${API}/auth/university-email`)
        .set(as('sami'))
        .send({ universityEmail: 'sami@gmail.test' })
        .expect(400);
      expect(domain.body.code).toBe('UNIVERSITY_EMAIL_DOMAIN_MISMATCH');
      const taken = await http()
        .post(`${API}/auth/university-email`)
        .set(as('sami'))
        .send({ universityEmail: 'hala.r@um.edu.sa' })
        .expect(409);
      expect(taken.body.code).toBe('UNIVERSITY_EMAIL_TAKEN');
      const same = await http()
        .post(`${API}/auth/university-email`)
        .set(as('hala'))
        .send({ universityEmail: 'HALA.R@um.edu.sa' })
        .expect(409);
      expect(same.body.code).toBe('UNIVERSITY_EMAIL_ALREADY_VERIFIED');
    });
  });

  // ==================================================================
  describe('Profile: at least one identifier is kept', () => {
    it('removing the only identifier is refused; with a verified university e-mail it is allowed', async () => {
      const res = await http()
        .patch(`${API}/users/me`)
        .set(as('sami'))
        .send({ studentNumber: null })
        .expect(400);
      expect(res.body.code).toBe('UNIVERSITY_IDENTITY_REQUIRED');
      await http()
        .patch(`${API}/users/me`)
        .set(as('hala'))
        .send({ studentNumber: 'um-2002' })
        .expect(200);
      const cleared = await http()
        .patch(`${API}/users/me`)
        .set(as('hala'))
        .send({ studentNumber: null })
        .expect(200);
      expect(cleared.body).toMatchObject({
        studentNumber: null,
        profileComplete: true,
        universityIdentity: { satisfiedBy: ['UNIVERSITY_EMAIL'] },
      });
    });
  });

  // ==================================================================
  describe('Existing students without an identifier (profile-incomplete)', () => {
    it('are kept as they are (no fake values) and reported as incomplete', async () => {
      const row = await db.user.create({
        data: {
          email: 'legacy@gmail.test',
          password: 'unused',
          firstName: 'Legacy',
          role: 'STUDENT',
          universityId: uniUM,
        },
      });
      ids.legacy = row!.id;
      tokens.legacy = jwt.sign({
        sub: row!.id,
        email: row!.email,
        role: 'STUDENT',
      });
      expect(await me('legacy')).toMatchObject({
        studentNumber: null,
        universityEmail: null,
        profileComplete: false,
        universityIdentity: { required: true, complete: false },
      });
      const dash = await http()
        .get(`${API}/dashboard/student`)
        .set(as('legacy'))
        .expect(200);
      expect(dash.body).toMatchObject({
        state: 'NO_PROJECT',
        viewer: { profileComplete: false },
      });
      const create = await http()
        .post(`${API}/projects`)
        .set(as('legacy'))
        .send({ name: 'Legacy project' })
        .expect(403);
      expect(create.body).toMatchObject({
        code: 'UNIVERSITY_IDENTITY_REQUIRED',
        details: { missing: ['UNIVERSITY_IDENTITY'] },
      });
      const stored = db.user.rows.find((u: any) => u.id === ids.legacy);
      expect(stored).toMatchObject({
        studentNumber: null,
        universityEmail: null,
      });
    });

    const p = { projectId: '', teamId: '', code: '' };

    it('they can still join a team as a MEMBER, but cannot be made leader', async () => {
      const res = await http()
        .post(`${API}/projects`)
        .set(as('sami'))
        .send({ name: 'Campus Navigator' })
        .expect(201);
      p.projectId = res.body.project.id;
      p.teamId = res.body.team.id;
      p.code = res.body.invitation.code;
      // sami's identity is fine; the other setup requirements are still open
      expect(res.body.setupReadiness.canComplete).toBe(false);
      expect(res.body.setupReadiness.missingRequirements).not.toContain(
        'UNIVERSITY_IDENTITY_REQUIRED',
      );
      await http()
        .post(`${API}/teams/join`)
        .set(as('legacy'))
        .send({ code: p.code })
        .expect(200);
      const promote = await http()
        .patch(`${API}/teams/${p.teamId}/leader`)
        .set(as('sami'))
        .send({ userId: ids.legacy })
        .expect(409);
      expect(promote.body.code).toBe('UNIVERSITY_IDENTITY_REQUIRED');
    });

    it('a leader without an identifier cannot manage the team; setup completion lists the missing identity', async () => {
      // simulate an existing leader account from before this rule
      const sami = db.user.rows.find((u: any) => u.id === ids.sami)!;
      sami.studentNumber = null;

      const ws = await http()
        .get(`${API}/projects/${p.projectId}`)
        .set(as('sami'))
        .expect(200);
      expect(ws.body.setupReadiness.canComplete).toBe(false);
      expect(ws.body.setupReadiness.missingRequirements).toContain(
        'UNIVERSITY_IDENTITY_REQUIRED',
      );
      // completing reports the missing identity among the setup requirements
      const complete = await http()
        .post(`${API}/projects/${p.projectId}/setup/complete`)
        .set(as('sami'))
        .expect(422);
      expect(complete.body.code).toBe('PROJECT_SETUP_INCOMPLETE');
      expect(complete.body.details.missingRequirements).toContain(
        'UNIVERSITY_IDENTITY_REQUIRED',
      );
      expect(ws.body.viewer).toMatchObject({
        isLeader: true,
        profileComplete: false,
      });

      for (const attempt of [
        () =>
          http()
            .post(`${API}/teams/${p.teamId}/student-invitations`)
            .set(as('sami'))
            .send({ universityEmail: 'hala.r@um.edu.sa' }),
        () =>
          http()
            .post(`${API}/tasks`)
            .set(as('sami'))
            .send({ projectId: p.projectId, title: 'Plan' }),
        () => http().get(`${API}/teams/${p.teamId}/invitation`).set(as('sami')),
      ]) {
        const res = await attempt().expect(403);
        expect(res.body.code).toBe('UNIVERSITY_IDENTITY_REQUIRED');
      }
      const project = db.project.rows.find((x: any) => x.id === p.projectId)!;
      expect(project.setupStep).toBe('TEAM');
    });

    it('after adding an identifier, the identity requirement is satisfied', async () => {
      await http()
        .patch(`${API}/users/me`)
        .set(as('sami'))
        .send({ studentNumber: 'UM-1001' })
        .expect(200);
      const res = await http()
        .post(`${API}/projects/${p.projectId}/setup/complete`)
        .set(as('sami'))
        .expect(422);
      // the identity requirement is now met; the remaining ones are project data
      expect(res.body.details.missingRequirements).not.toContain(
        'UNIVERSITY_IDENTITY_REQUIRED',
      );
      expect(res.body.details.missingRequirements).toContain(
        'HANDBOOK_REQUIRED',
      );
    });

    it('the legacy member adds and verifies a university e-mail, then can be made leader', async () => {
      const req = await http()
        .post(`${API}/auth/university-email`)
        .set(as('legacy'))
        .send({ universityEmail: 'legacy@um.edu.sa' })
        .expect(200);
      expect(req.body.status).toBe('PENDING_VERIFICATION');
      await http()
        .post(`${API}/auth/verify-university-email`)
        .send({
          token: lastLink('legacy@um.edu.sa', 'verify-university-email'),
        })
        .expect(200);
      await http()
        .patch(`${API}/teams/${p.teamId}/leader`)
        .set(as('sami'))
        .send({ userId: ids.legacy })
        .expect(200);
    });
  });

  // ==================================================================
  describe('Leader finds and invites by student number or university e-mail', () => {
    let leader = '';

    beforeAll(async () => {
      // ziad (verified university e-mail only) leads a new project
      const res = await http()
        .post(`${API}/projects`)
        .set(as('ziad'))
        .send({ name: 'Smart Library' })
        .expect(201);
      leader = res.body.team.id;
    });

    it('search by verified university e-mail returns safe, masked data only', async () => {
      const res = await http()
        .get(`${API}/students/search?universityEmail=HALA.R@um.edu.sa`)
        .set(as('ziad'))
        .expect(200);
      expect(res.body).toEqual({
        displayName: 'Hala R.',
        matchedBy: 'UNIVERSITY_EMAIL',
        maskedIdentifier: 'h***@um.edu.sa',
        university: { id: uniUM, name: 'Almaarefa University' },
        availability: 'AVAILABLE',
      });
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('hala@gmail.test');
      expect(text).not.toContain(ids.hala);
    });

    it('exactly one identifier; other universities and unknown values give 404', async () => {
      for (const qs of [
        '',
        '?studentNumber=UM-1001&universityEmail=hala.r@um.edu.sa',
      ]) {
        const res = await http()
          .get(`${API}/students/search${qs}`)
          .set(as('ziad'))
          .expect(400);
        expect(res.body.code).toBe('STUDENT_IDENTIFIER_REQUIRED');
      }
      await http()
        .get(`${API}/students/search?universityEmail=hala.r@um.edu.sa`)
        .set(as('mona')) // other university
        .expect(404);
      await http()
        .get(`${API}/students/search?universityEmail=nobody@um.edu.sa`)
        .set(as('ziad'))
        .expect(404);
      const byNumber = await http()
        .get(`${API}/students/search?studentNumber=um-1001`)
        .set(as('ziad'))
        .expect(200);
      expect(byNumber.body).toMatchObject({
        matchedBy: 'STUDENT_NUMBER',
        maskedIdentifier: 'UM***01',
        availability: 'AVAILABLE', // in another team, but students can be in several teams
      });
    });

    it('invitation by university e-mail', async () => {
      const res = await http()
        .post(`${API}/teams/${leader}/student-invitations`)
        .set(as('ziad'))
        .send({ universityEmail: 'hala.r@um.edu.sa' })
        .expect(201);
      expect(res.body.status).toBe('PENDING');
      expect(JSON.stringify(res.body)).not.toContain('hala@gmail.test');
      await http()
        .post(`${API}/team-invitations/${res.body.id}/accept`)
        .set(as('hala'))
        .expect(200);
      const both = await http()
        .post(`${API}/teams/${leader}/student-invitations`)
        .set(as('ziad'))
        .send({ universityEmail: 'x@um.edu.sa', studentNumber: 'UM-1001' })
        .expect(400);
      expect(both.body.code).toBe('STUDENT_IDENTIFIER_REQUIRED');
    });
  });
});
