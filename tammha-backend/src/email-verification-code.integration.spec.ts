import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AuthTokenType } from '@prisma/client';
import { PrismaService } from './prisma/prisma.service';
import { configureApp } from './app.setup';
import {
  createInMemoryPrisma,
  InMemoryPrisma,
} from './testing/in-memory-prisma';
import { applyTestEnv } from './testing/test-env';
import { FakeStorageService } from './testing/fake-storage';
import { FakeEmailSender } from './testing/fake-email-sender';
import { verificationCodeIn } from './testing/verification-code';
import { SupabaseStorageService } from '@modules/documents/supabase-storage.service';
import { EMAIL_SENDER } from '@/integrations/email/email.sender';
import { AuthTokensService } from '@modules/auth/auth-tokens.service';

const API = '/api/v1';
const PASSWORD = 'Password123';

/**
 * P17 — e-mail verification by 6-digit code (AppModule, verification required):
 * codes instead of links, resend with cooldown and hourly cap, and a fallback that moves
 * an unverified account to another address.
 */
describe('E-mail verification by code (P17, AppModule integration)', () => {
  let app: INestApplication;
  let db: InMemoryPrisma;
  const mail = new FakeEmailSender();
  let uni = '';
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const http = () => request(app.getHttpServer());
  const as = (k: string) => ({ Authorization: `Bearer ${tokens[k]}` });

  const lastMailTo = (to: string) =>
    [...mail.sent].reverse().find((m) => m.to === to);
  const lastCode = (to: string) =>
    [...mail.sent]
      .reverse()
      .map((m) => (m.to === to ? verificationCodeIn(m.text) : null))
      .find((c) => !!c) ?? null;
  const codesTo = (to: string) =>
    mail.sent.filter((m) => m.to === to && verificationCodeIn(m.text)).length;
  const codeRows = (k: string) =>
    (db.authToken.rows as any[]).filter(
      (t) =>
        t.userId === ids[k] &&
        t.type === AuthTokenType.EMAIL_VERIFICATION &&
        t.attempts !== null,
    );
  /** moves this user's codes into the past (skips the 60-second cooldown) */
  const age = (k: string, ms: number) => {
    for (const t of codeRows(k)) t.createdAt = new Date(t.createdAt - ms);
  };
  const wrong = (code: string) => (code === '000000' ? '111111' : '000000');
  const verify = (email: string, code: string | null) =>
    http().post(`${API}/auth/verify-email/code`).send({ email, code });

  async function signUp(key: string, lang: 'ar' | 'en' = 'en') {
    const email = `${key}@uni.edu.sa`;
    const res = await http()
      .post(`${API}/auth/register`)
      .send({
        email,
        password: PASSWORD,
        firstName: key,
        role: 'STUDENT',
        universityId: uni,
        studentNumber: `S-${key}`,
        accountEmailIsUniversityEmail: true,
        preferredLanguage: lang,
      })
      .expect(201);
    ids[key] = res.body.user.id;
    tokens[key] = res.body.tokens.accessToken;
    return email;
  }

  beforeAll(async () => {
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
      .overrideProvider(EMAIL_SENDER)
      .useValue(mail)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    applyTestEnv();
  });

  it('registration e-mails a 6-digit code: no links, html + text, subject with the code', async () => {
    const email = await signUp('rana', 'ar');
    const msg = lastMailTo(email)!;
    const code = lastCode(email)!;
    expect(code).toMatch(/^\d{6}$/);
    expect(msg.subject).toBe(`تمّمها | رمز التحقق: ${code}`);
    expect(msg.text).toContain(code);
    expect(msg.html).toContain(code);
    expect(msg.text).not.toMatch(/https?:/);
    expect(msg.html).not.toMatch(/https?:/);
    expect(msg.html).not.toContain('<a ');
    // only a digest is stored
    expect(JSON.stringify(db.authToken.rows)).not.toContain(`"${code}"`);
  });

  it('the right code verifies; the account then has full access', async () => {
    const email = `rana@uni.edu.sa`;
    const blocked = await http()
      .get(`${API}/dashboard/student`)
      .set(as('rana'))
      .expect(403);
    expect(blocked.body.code).toBe('EMAIL_NOT_VERIFIED');
    const res = await verify(email, lastCode(email)).expect(200);
    expect(res.body.emailVerified).toBe(true);
    const me = await http().get(`${API}/auth/me`).set(as('rana')).expect(200);
    expect(me.body.emailVerified).toBe(true);
    await http().get(`${API}/dashboard/student`).set(as('rana')).expect(200);
  });

  it('wrong, reused and expired codes fail with the same error; unknown e-mail too', async () => {
    const email = await signUp('omar');
    const code = lastCode(email)!;
    const bad = await verify(email, wrong(code)).expect(400);
    expect(bad.body.code).toBe('VERIFICATION_CODE_INVALID');
    const unknown = await verify('ghost@uni.edu.sa', code).expect(400);
    expect(unknown.body.code).toBe(bad.body.code);
    expect(unknown.body.message).toBe(bad.body.message);

    // expired: 10 minutes
    for (const t of codeRows('omar')) t.expiresAt = new Date(Date.now() - 1);
    const expired = await verify(email, code).expect(400);
    expect(expired.body.code).toBe('VERIFICATION_CODE_INVALID');

    // a fresh code works once; using it again on another account state is refused
    age('omar', 120_000);
    await http()
      .post(`${API}/auth/verify-email/resend`)
      .send({ email })
      .expect(200);
    const fresh = lastCode(email)!;
    const tokensSvc = app.get(AuthTokensService);
    expect(
      await tokensSvc.checkCode(
        ids.omar,
        AuthTokenType.EMAIL_VERIFICATION,
        fresh,
      ),
    ).toBe('OK');
    // consumed: the same code no longer works
    const reused = await verify(email, fresh).expect(400);
    expect(reused.body.code).toBe('VERIFICATION_CODE_INVALID');
  });

  it('five wrong attempts use the code up', async () => {
    const email = await signUp('sara');
    const code = lastCode(email)!;
    for (let i = 0; i < 5; i++) await verify(email, wrong(code)).expect(400);
    await verify(email, code).expect(400);
    const me = await http().get(`${API}/auth/me`).set(as('sara')).expect(200);
    expect(me.body.emailVerified).toBe(false);
  });

  it('resend: generic answer, 60-second cooldown, a new code replaces the old one, 5 per hour', async () => {
    const email = await signUp('huda');
    const first = lastCode(email)!;
    const unknown = await http()
      .post(`${API}/auth/verify-email/resend`)
      .send({ email: 'ghost@uni.edu.sa' })
      .expect(200);
    const cooling = await http()
      .post(`${API}/auth/verify-email/resend`)
      .send({ email })
      .expect(200);
    // no new code during the cooldown; same message as for an unknown address
    expect(codesTo(email)).toBe(1);
    expect(cooling.body.message).toBe(unknown.body.message);
    expect(cooling.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(cooling.body.retryAfterSeconds).toBeLessThanOrEqual(60);

    age('huda', 61_000);
    await http()
      .post(`${API}/auth/verify-email/resend`)
      .send({ email })
      .expect(200);
    expect(codesTo(email)).toBe(2);
    const second = lastCode(email)!;
    if (second !== first) await verify(email, first).expect(400);

    // up to 5 codes in an hour, then the answer says how long to wait
    for (let i = 0; i < 3; i++) {
      age('huda', 61_000);
      await http()
        .post(`${API}/auth/verify-email/resend`)
        .send({ email })
        .expect(200);
    }
    expect(codesTo(email)).toBe(5);
    age('huda', 61_000);
    const capped = await http()
      .post(`${API}/auth/verify-email/resend`)
      .send({ email })
      .expect(200);
    expect(codesTo(email)).toBe(5);
    expect(capped.body.retryAfterSeconds).toBeGreaterThan(60);
    // the capped request did not cancel the latest code
    expect(codeRows('huda').filter((t) => !t.usedAt)).toHaveLength(1);
  });

  it('change-email: wrong password, verified account and taken address are refused', async () => {
    const email = await signUp('noor');
    await http()
      .post(`${API}/auth/verify-email/change-email`)
      .send({
        currentEmail: email,
        password: 'WrongPass1',
        newEmail: 'noor@gmail.com',
      })
      .expect(401);
    const taken = await http()
      .post(`${API}/auth/verify-email/change-email`)
      .send({
        currentEmail: email,
        password: PASSWORD,
        newEmail: 'rana@uni.edu.sa',
      })
      .expect(409);
    expect(taken.body.code).toBe('EMAIL_TAKEN');
    const verified = await http()
      .post(`${API}/auth/verify-email/change-email`)
      .send({
        currentEmail: 'rana@uni.edu.sa',
        password: PASSWORD,
        newEmail: 'rana@gmail.com',
      })
      .expect(409);
    expect(verified.body.code).toBe('EMAIL_ALREADY_VERIFIED');
    const unchanged = await http()
      .post(`${API}/auth/verify-email/change-email`)
      .send({ currentEmail: email, password: PASSWORD, newEmail: email })
      .expect(400);
    expect(unchanged.body.code).toBe('EMAIL_UNCHANGED');
  });

  it('change-email: the code goes to the new address; the old code stops working', async () => {
    const oldEmail = 'noor@uni.edu.sa';
    const oldCode = lastCode(oldEmail)!;
    const res = await http()
      .post(`${API}/auth/verify-email/change-email`)
      .send({
        currentEmail: oldEmail,
        password: PASSWORD,
        newEmail: 'Noor.Personal@Gmail.com',
      })
      .expect(200);
    expect(res.body.email).toBe('noor.personal@gmail.com');
    const newCode = lastCode('noor.personal@gmail.com');
    expect(newCode).toMatch(/^\d{6}$/);
    await verify(oldEmail, oldCode).expect(400);
    await verify(
      'noor.personal@gmail.com',
      oldCode === newCode ? wrong(newCode!) : oldCode,
    ).expect(400);
    await verify(
      'noor.personal@gmail.com',
      lastCode('noor.personal@gmail.com'),
    ).expect(200);
    const login = await http()
      .post(`${API}/auth/login`)
      .send({ email: 'noor.personal@gmail.com', password: PASSWORD })
      .expect(200);
    expect(login.body.user).toMatchObject({
      email: 'noor.personal@gmail.com',
      emailVerified: true,
    });
  });

  it('a link sent before P17 still verifies until it expires', async () => {
    const email = await signUp('legacy');
    const raw = await app
      .get(AuthTokensService)
      .issue(ids.legacy, AuthTokenType.EMAIL_VERIFICATION);
    // a new code does not cancel the older link
    age('legacy', 61_000);
    await http()
      .post(`${API}/auth/verify-email/resend`)
      .send({ email })
      .expect(200);
    await http()
      .post(`${API}/auth/verify-email`)
      .send({ token: raw })
      .expect(200);
    const me = await http().get(`${API}/auth/me`).set(as('legacy')).expect(200);
    expect(me.body.emailVerified).toBe(true);
  });

  it('login of an unverified account tells the frontend to show the code screen', async () => {
    await signUp('late');
    const login = await http()
      .post(`${API}/auth/login`)
      .send({ email: 'late@uni.edu.sa', password: PASSWORD })
      .expect(200);
    expect(login.body).toMatchObject({
      emailVerificationRequired: true,
      user: { emailVerified: false },
    });
    const gated = await http()
      .get(`${API}/notifications`)
      .set({ Authorization: `Bearer ${login.body.tokens.accessToken}` })
      .expect(403);
    expect(gated.body).toMatchObject({
      code: 'EMAIL_NOT_VERIFIED',
      details: { verifyWith: 'POST /auth/verify-email/code' },
    });
  });
});
