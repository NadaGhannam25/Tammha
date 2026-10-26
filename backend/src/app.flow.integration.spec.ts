import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';
import { configureApp, createSwaggerDocument } from './app.setup';
import {
  createInMemoryPrisma,
  InMemoryPrisma,
} from './testing/in-memory-prisma';

/**
 * END-TO-END FLOW on the real AppModule (all modules, env validation, guards,
 * pipes, filter, Swagger). Only PrismaService is replaced by the in-memory store.
 * Configuration comes from src/testing/test-env.ts (jest setupFiles), not from .env.
 *
 * Register student -> Login -> JWT -> Create Project (+ Team) -> Manage Team ->
 * Invitation Code/Link -> Join -> Retrieve Project
 */
describe('Complete flow (AppModule integration)', () => {
  let app: INestApplication;
  let db: InMemoryPrisma;
  let universityId = '';
  const API = '/api/v1';

  beforeAll(async () => {
    db = createInMemoryPrisma();
    universityId = (await db.university.create({
      data: { name: 'Almaarefa University', code: 'UM' },
    }))!.id;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
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
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  const state = {
    leaderToken: '',
    memberToken: '',
    projectId: '',
    teamId: '',
    code: '',
    link: '',
  };

  it('0. GET /health and GET /universities (public)', async () => {
    const health = await http().get(`${API}/health`).expect(200);
    expect(health.body).toMatchObject({ status: 'ok', database: 'connected' });

    const unis = await http().get(`${API}/universities`).expect(200);
    expect(unis.body).toEqual([
      { id: universityId, name: 'Almaarefa University', code: 'UM' },
    ]);
  });

  it('1. Register two students', async () => {
    for (const [first, email] of [
      ['Rand', 'rand@um.edu.sa'],
      ['Nada', 'nada@um.edu.sa'],
    ]) {
      const res = await http()
        .post(`${API}/auth/register`)
        .send({
          email,
          password: 'Password123',
          firstName: first,
          role: 'STUDENT',
          universityId,
        })
        .expect(201);
      expect(res.body.user).toMatchObject({
        email,
        role: 'STUDENT',
        universityId,
      });
      expect(res.body.user).not.toHaveProperty('password');
    }
  });

  it('2-3. Login and receive a valid JWT', async () => {
    const res = await http()
      .post(`${API}/auth/login`)
      .send({ email: 'rand@um.edu.sa', password: 'Password123' })
      .expect(200);
    state.leaderToken = res.body.tokens.accessToken;

    const payload = JSON.parse(
      Buffer.from(state.leaderToken.split('.')[1], 'base64url').toString(),
    );
    expect(payload).toMatchObject({ email: 'rand@um.edu.sa', role: 'STUDENT' });
    expect(payload.exp - payload.iat).toBe(3600);

    await http()
      .get(`${API}/auth/me`)
      .set(bearer(state.leaderToken))
      .expect(200);
  });

  it('4. Create Project (creates the team in the same transaction)', async () => {
    const res = await http()
      .post(`${API}/projects`)
      .set(bearer(state.leaderToken))
      .send({
        name: 'Tammha',
        description: 'GP management platform',
        teamName: 'Team Tammha',
      })
      .expect(201);
    state.projectId = res.body.project.id;
    state.teamId = res.body.team.id;
    expect(res.body.team.members).toHaveLength(1);
    expect(res.body.team.members[0].teamRole).toBe('LEADER');
  });

  it('5. Team: retrieve and update', async () => {
    const me = await http()
      .get(`${API}/teams/me`)
      .set(bearer(state.leaderToken))
      .expect(200);
    expect(me.body).toMatchObject({
      id: state.teamId,
      projectId: state.projectId,
      universityId,
    });

    await http()
      .patch(`${API}/teams/${state.teamId}`)
      .set(bearer(state.leaderToken))
      .send({ description: 'Graduation project team' })
      .expect(200);
  });

  it('6. Generate Invitation Code / Link', async () => {
    const res = await http()
      .get(`${API}/teams/${state.teamId}/invitation`)
      .set(bearer(state.leaderToken))
      .expect(200);
    state.code = res.body.code;
    state.link = res.body.link;
    expect(state.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(state.link).toBe(`https://tammha.test/join/${state.code}`);
  });

  it('7. Second student previews and joins with the link', async () => {
    const login = await http()
      .post(`${API}/auth/login`)
      .send({ email: 'NADA@um.edu.sa', password: 'Password123' })
      .expect(200);
    state.memberToken = login.body.tokens.accessToken;

    await http()
      .get(`${API}/teams/invitations/${state.code}`)
      .set(bearer(state.memberToken))
      .expect(200);

    const res = await http()
      .post(`${API}/teams/join`)
      .set(bearer(state.memberToken))
      .send({ code: state.link })
      .expect(200);
    expect(res.body).toMatchObject({
      teamId: state.teamId,
      projectId: state.projectId,
    });
  });

  it('7b. Duplicate membership is prevented', async () => {
    const again = await http()
      .post(`${API}/teams/join`)
      .set(bearer(state.memberToken))
      .send({ code: state.code })
      .expect(409);
    expect(again.body.code).toBe('ALREADY_IN_THIS_TEAM');

    const second = await http()
      .post(`${API}/projects`)
      .set(bearer(state.memberToken))
      .send({ name: 'Second project' })
      .expect(409);
    expect(second.body.code).toBe('ALREADY_IN_A_TEAM');
    expect(db.teamMember.rows).toHaveLength(2);
  });

  it('8. Retrieve Project: both students see the same workspace', async () => {
    const asMember = await http()
      .get(`${API}/projects/me`)
      .set(bearer(state.memberToken))
      .expect(200);
    const asLeader = await http()
      .get(`${API}/projects/${state.projectId}`)
      .set(bearer(state.leaderToken))
      .expect(200);

    for (const res of [asMember, asLeader]) {
      expect(res.body.project).toMatchObject({
        id: state.projectId,
        name: 'Tammha',
      });
      expect(
        res.body.team.members.map((m: any) => m.user.email).sort(),
      ).toEqual(['nada@um.edu.sa', 'rand@um.edu.sa']);
      expect(JSON.stringify(res.body)).not.toContain('password');
    }
  });

  it('Error format is consistent (404 unknown route, 400 validation, 401)', async () => {
    const notFound = await http().get(`${API}/does-not-exist`).expect(404);
    expect(notFound.body).toMatchObject({
      statusCode: 404,
      path: `${API}/does-not-exist`,
    });

    const invalid = await http().post(`${API}/auth/login`).send({}).expect(400);
    expect(Array.isArray(invalid.body.message)).toBe(true);

    const unauth = await http().get(`${API}/projects/me`).expect(401);
    expect(unauth.body).toHaveProperty('timestamp');

    // JSON bodies over the 100 KB limit: 413 with the standard shape (was a 500)
    const huge = await http()
      .post(`${API}/auth/login`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'a@b.c', password: 'x'.repeat(200_000) }))
      .expect(413);
    expect(huge.body).toMatchObject({
      statusCode: 413,
      code: 'PAYLOAD_TOO_LARGE',
    });
  });

  it('Swagger: protected operations declare the jwt scheme; public ones do not; ids unique', () => {
    const doc = createSwaggerDocument(app);
    const publicOps = new Set([
      'get /api/v1/health',
      'get /api/v1/universities',
      'post /api/v1/auth/register',
      'post /api/v1/auth/login',
      'post /api/v1/auth/refresh',
    ]);
    const missing: string[] = [];
    const operationIds = new Set<string>();

    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item as Record<string, any>)) {
        const key = `${method} ${path}`;
        expect(operationIds.has(op.operationId)).toBe(false);
        operationIds.add(op.operationId);
        const secured = (op.security ?? []).some(
          (s: Record<string, unknown>) => 'jwt' in s,
        );
        if (!publicOps.has(key) && !secured) missing.push(key);
        if (publicOps.has(key)) expect(secured).toBe(false);
      }
    }
    expect(missing).toEqual([]);
  });
});
