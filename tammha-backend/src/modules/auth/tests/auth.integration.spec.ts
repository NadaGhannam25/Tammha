import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AuthModule } from '../auth.module';
import { PrismaService } from '@/prisma/prisma.service';
import { configureApp } from '@/app.setup';
import { testConfigModule } from '@/testing/test-env';
import {
  createInMemoryPrisma,
  InMemoryPrisma,
} from '@/testing/in-memory-prisma';

/**
 * HTTP integration tests for /api/v1/auth/*.
 * Real: controller, AuthService, UsersService, JWT, passport strategy, bcrypt,
 * global ValidationPipe + exception filter (configureApp). Prisma = in-memory test store.
 */
describe('Auth (integration)', () => {
  let app: INestApplication;
  let db: InMemoryPrisma;
  let universityId = '';

  const student = {
    email: 'Integration.Student@Test.Local',
    password: 'Password123',
    firstName: '  Int  ',
    lastName: 'Student',
    role: 'STUDENT',
    studentNumber: 'int-001',
    // the university has no e-mail domains configured: say the account e-mail is the university e-mail
    accountEmailIsUniversityEmail: true,
  };

  beforeAll(async () => {
    db = createInMemoryPrisma();
    const uni = await db.university.create({
      data: { name: 'Test University', code: 'TU' },
    });
    universityId = uni!.id;

    const moduleRef = await Test.createTestingModule({
      imports: [testConfigModule(), AuthModule],
    })
      .overrideProvider(PrismaService)
      .useValue(db)
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  const http = () => request(app.getHttpServer());
  let accessToken = '';
  let refreshToken = '';

  it('register -> 201; email stored lower-case; password and token hashed', async () => {
    const res = await http()
      .post('/api/v1/auth/register')
      .send({ ...student, universityId })
      .expect(201);

    expect(res.body.user.email).toBe('integration.student@test.local');
    expect(res.body.user.firstName).toBe('Int');
    expect(res.body.user).not.toHaveProperty('password');
    expect(res.body.tokens.expiresIn).toBe(3600);

    const stored = db.user.rows.find(
      (u) => u.email === 'integration.student@test.local',
    )!;
    expect(stored.password).toMatch(/^\$2[aby]\$04\$/);
    expect(db.refreshToken.rows[0].tokenHash).not.toBe(
      res.body.tokens.refreshToken,
    );
  });

  it('register -> 409 for the same email in another case', async () => {
    await http()
      .post('/api/v1/auth/register')
      .send({
        ...student,
        email: 'INTEGRATION.STUDENT@test.local',
        universityId,
      })
      .expect(409);
  });

  it('register -> 400 for unknown universityId, ADMIN role, invalid body, extra fields', async () => {
    const base = { ...student, email: 'other@test.local' };
    await http()
      .post('/api/v1/auth/register')
      .send({ ...base, universityId: 'nope' })
      .expect(400);
    await http()
      .post('/api/v1/auth/register')
      .send({ ...base, universityId, role: 'ADMIN' })
      .expect(400);
    await http()
      .post('/api/v1/auth/register')
      .send({ email: 'bad', password: 'short' })
      .expect(400);
    await http()
      .post('/api/v1/auth/register')
      .send({ ...base, universityId, isActive: false })
      .expect(400);
  });

  it('register: student ID and university e-mail are required; supervisors cannot self-register', async () => {
    const base = { ...student, universityId };
    const noNumber = await http()
      .post('/api/v1/auth/register')
      .send({ ...base, email: 'n1@uni.example', studentNumber: undefined })
      .expect(400);
    expect(noNumber.body.code).toBe('STUDENT_NUMBER_REQUIRED');

    const noUniEmail = await http()
      .post('/api/v1/auth/register')
      .send({
        ...base,
        email: 'n2@uni.example',
        studentNumber: 'int-002',
        accountEmailIsUniversityEmail: undefined,
      })
      .expect(400);
    expect(noUniEmail.body.code).toBe('UNIVERSITY_EMAIL_REQUIRED');

    const personal = await http()
      .post('/api/v1/auth/register')
      .send({ ...base, email: 'n3@gmail.com', studentNumber: 'int-003' })
      .expect(400);
    expect(personal.body.code).toBe('UNIVERSITY_EMAIL_DOMAIN_MISMATCH');

    // supervisors register themselves with a university address (never a personal one)
    const personalSup = await http()
      .post('/api/v1/auth/register')
      .send({
        email: 'sup@gmail.com',
        password: 'Password123',
        firstName: 'Sup',
        role: 'SUPERVISOR',
        universityId,
      })
      .expect(400);
    expect(personalSup.body.code).toBe('SUPERVISOR_UNIVERSITY_EMAIL_REQUIRED');
    expect(db.user.rows.some((u) => u.email === 'sup@gmail.com')).toBe(false);

    const supervisor = await http()
      .post('/api/v1/auth/register')
      .send({
        email: 'sup@uni.example',
        password: 'Password123',
        firstName: 'Sup',
        role: 'SUPERVISOR',
        universityId,
        studentNumber: 'IGNORED-1',
      })
      .expect(201);
    expect(supervisor.body.user.role).toBe('SUPERVISOR');
    expect(supervisor.body.user.studentNumber ?? null).toBeNull();
    expect(supervisor.body.user.emailVerified).toBe(false);
  });

  it('login -> 200 (case-insensitive email)', async () => {
    const res = await http()
      .post('/api/v1/auth/login')
      .send({
        email: 'INTEGRATION.student@test.local',
        password: student.password,
      })
      .expect(200);
    accessToken = res.body.tokens.accessToken;
    refreshToken = res.body.tokens.refreshToken;
    expect(res.body.user).not.toHaveProperty('password');
  });

  it('login -> 401 with the same message for wrong password and unknown email', async () => {
    const a = await http()
      .post('/api/v1/auth/login')
      .send({ email: student.email, password: 'WrongPassword1' })
      .expect(401);
    const b = await http()
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@test.local', password: 'WrongPassword1' })
      .expect(401);
    expect(a.body.message).toBe(b.body.message);
  });

  it('me -> 401 without / with tampered token; 200 with valid token, no password', async () => {
    await http().get('/api/v1/auth/me').expect(401);
    await http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}x`)
      .expect(401);
    const res = await http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body).toMatchObject({
      email: 'integration.student@test.local',
      role: 'STUDENT',
    });
    expect(res.body).not.toHaveProperty('password');
  });

  it('refresh -> rotates; the old token cannot be reused', async () => {
    const res = await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(200);
    expect(res.body.refreshToken).not.toBe(refreshToken);
    await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(401);
    refreshToken = res.body.refreshToken;
    accessToken = res.body.accessToken;
  });

  it('refresh -> 400 when the token is missing', async () => {
    await http().post('/api/v1/auth/refresh').send({}).expect(400);
  });

  it('logout -> revokes refresh tokens', async () => {
    await http()
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect({ message: 'Logout successful' });
    await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(401);
  });

  it('me -> 401 once the user is deactivated', async () => {
    const stored = db.user.rows.find(
      (u) => u.email === 'integration.student@test.local',
    )!;
    stored.isActive = false;
    await http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(401);
    stored.isActive = true;
  });
});
