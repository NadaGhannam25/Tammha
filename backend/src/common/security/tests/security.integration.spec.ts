import { Test } from '@nestjs/testing';
import { INestApplication, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import * as jsonwebtoken from 'jsonwebtoken';
import { PrismaService } from '@/prisma/prisma.service';
import { configureApp, setupSwagger } from '@/app.setup';
import { AppController } from '@/app.controller';
import { AppService } from '@/app.service';
import {
  TestEnvOverrides,
  testConfigModule,
  TEST_ENV,
} from '@/testing/test-env';
import {
  createInMemoryPrisma,
  InMemoryPrisma,
} from '@/testing/in-memory-prisma';
import { FakeStorageService } from '@/testing/fake-storage';
import { SecurityModule } from '@common/security/security.module';
import { PrismaModule } from '@/prisma/prisma.module';
import { AuthModule } from '@modules/auth/auth.module';
import { ProjectsModule } from '@modules/projects/projects.module';
import { TeamsModule } from '@modules/teams/teams.module';
import { UniversitiesModule } from '@modules/universities/universities.module';
import { DocumentsModule } from '@modules/documents/documents.module';
import { SupabaseStorageService } from '@modules/documents/supabase-storage.service';
import {
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from '@/config/security.config';

/**
 * P14 — HTTP security behaviour on the real modules (Prisma in memory, fake storage):
 * security headers, CORS, JWT pinning, password policy, refresh-token reuse,
 * rate limiting, health 503, upload content checks, Swagger CSP.
 */
const API = '/api/v1';

async function createApp(overrides: TestEnvOverrides = {}) {
  const db = createInMemoryPrisma();
  const storage = new FakeStorageService();
  const university = await db.university.create({
    data: { name: 'Security University', code: 'SEC' },
  });
  const moduleRef = await Test.createTestingModule({
    imports: [
      testConfigModule(overrides),
      PrismaModule,
      SecurityModule,
      AuthModule,
      UniversitiesModule,
      TeamsModule,
      ProjectsModule,
      DocumentsModule,
    ],
    controllers: [AppController],
    providers: [AppService],
  })
    .overrideProvider(PrismaService)
    .useValue(db)
    .overrideProvider(SupabaseStorageService)
    .useValue(storage)
    .compile();
  const app = moduleRef.createNestApplication();
  const { apiPrefix } = configureApp(app);
  setupSwagger(app, apiPrefix);
  await app.init();
  return { app, db, storage, universityId: university!.id };
}

describe('Security (P14) — headers, CORS, JWT, passwords, uploads, health', () => {
  let app: INestApplication;
  let db: InMemoryPrisma;
  let storage: FakeStorageService;
  let universityId = '';
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    ({ app, db, storage, universityId } = await createApp({
      CORS_ORIGINS: 'http://localhost:5173',
      FRONTEND_ORIGIN: 'https://app.tammha.test',
    }));
  });
  afterAll(async () => {
    await app?.close();
  });

  const register = (
    email: string,
    password = 'Password123',
    role = 'STUDENT',
  ) =>
    http()
      .post(`${API}/auth/register`)
      .send({ email, password, role, universityId, firstName: 'T' });

  // ---------------- headers ----------------
  it('sets security headers on API responses and hides the framework', async () => {
    const res = await http().get(`${API}/health`).expect(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    // HSTS only in production (TLS terminates at the host)
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('Swagger UI keeps a CSP that lets its own scripts run (no inline scripts)', async () => {
    const page = await http().get(`${API}/docs/`).expect(200);
    const csp = page.headers['content-security-policy'];
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    // swagger-ui only loads scripts from files, never inline <script> code
    expect(page.text).not.toMatch(/<script>(?!\s*<\/script>)[^<]+<\/script>/);
    await http().get(`${API}/docs-json`).expect(200);
  });

  // ---------------- CORS ----------------
  it('CORS allows FRONTEND_ORIGIN and CORS_ORIGINS, without credentials', async () => {
    for (const origin of ['https://app.tammha.test', 'http://localhost:5173']) {
      const pre = await http()
        .options(`${API}/auth/login`)
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type,authorization')
        .expect(204);
      expect(pre.headers['access-control-allow-origin']).toBe(origin);
      expect(pre.headers['access-control-allow-credentials']).toBeUndefined();
      expect(pre.headers['access-control-allow-headers']).toBe(
        'Content-Type,Authorization',
      );
    }
  });

  it('CORS gives no permission to other origins', async () => {
    const res = await http()
      .get(`${API}/health`)
      .set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const pre = await http()
      .options(`${API}/auth/login`)
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
  });

  // ---------------- JWT ----------------
  describe('JWT', () => {
    let userId = '';
    let accessToken = '';
    const me = (token: string) =>
      http().get(`${API}/auth/me`).set('Authorization', `Bearer ${token}`);

    beforeAll(async () => {
      const res = await register('jwt@test.local').expect(201);
      userId = res.body.user.id;
      accessToken = res.body.tokens.accessToken;
    });

    it('issues HS256 tokens with issuer, audience and expiry', () => {
      const decoded = jsonwebtoken.decode(accessToken, { complete: true }) as {
        header: { alg: string };
        payload: Record<string, unknown>;
      };
      expect(decoded.header.alg).toBe(JWT_ALGORITHM);
      expect(decoded.payload).toMatchObject({
        sub: userId,
        iss: JWT_ISSUER,
        aud: JWT_AUDIENCE,
      });
      expect(
        (decoded.payload.exp as number) - (decoded.payload.iat as number),
      ).toBe(3600);
      expect(decoded.payload).not.toHaveProperty('password');
    });

    it('accepts its own token', async () => {
      await me(accessToken).expect(200);
    });

    const forge = (
      options: jsonwebtoken.SignOptions,
      secret: string = TEST_ENV.JWT_SECRET,
      payload: object = { sub: userId, email: 'jwt@test.local', role: 'ADMIN' },
    ) => jsonwebtoken.sign(payload, secret, { expiresIn: '1h', ...options });

    it.each([
      ['no issuer/audience', { algorithm: 'HS256' as const }],
      [
        'another audience',
        {
          algorithm: 'HS256' as const,
          issuer: JWT_ISSUER,
          audience: 'other-app',
        },
      ],
      [
        'another issuer',
        { algorithm: 'HS256' as const, issuer: 'evil', audience: JWT_AUDIENCE },
      ],
      [
        'HS512 instead of HS256',
        {
          algorithm: 'HS512' as const,
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
        },
      ],
      [
        'expired',
        {
          algorithm: 'HS256' as const,
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
          expiresIn: -10,
        },
      ],
    ])('rejects a token with %s (401)', async (_label, options) => {
      const res = await me(forge(options)).expect(401);
      expect(JSON.stringify(res.body)).not.toMatch(/stack|secret/i);
    });

    it('rejects a token signed with another secret', async () => {
      await me(
        forge(
          { algorithm: 'HS256', issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
          'another-secret-another-secret-another-secret',
        ),
      ).expect(401);
    });

    it('rejects alg "none" tokens', async () => {
      const b64 = (o: object) =>
        Buffer.from(JSON.stringify(o)).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const token = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
        sub: userId,
        role: 'ADMIN',
        iss: JWT_ISSUER,
        aud: JWT_AUDIENCE,
        iat: now,
        exp: now + 3600,
      })}.`;
      await me(token).expect(401);
    });

    it('rejects a valid signature whose payload has no subject', async () => {
      const token = app.get(JwtService).sign({ role: 'ADMIN' });
      await me(token).expect(401);
    });

    it('the role in the token is not trusted: the database role is used', async () => {
      const token = app
        .get(JwtService)
        .sign({ sub: userId, email: 'jwt@test.local', role: 'ADMIN' });
      const res = await me(token).expect(200);
      expect(res.body.role).toBe('STUDENT');
      await http()
        .get(`${API}/admin/handbooks`)
        .set('Authorization', `Bearer ${token}`)
        .expect((r) => expect([403, 404]).toContain(r.status));
    });

    it('a deactivated user is rejected even with a valid token', async () => {
      const res = await register('inactive@test.local').expect(201);
      await db.user.update({
        where: { id: res.body.user.id },
        data: { isActive: false },
      });
      await me(res.body.tokens.accessToken).expect(401);
    });
  });

  // ---------------- passwords / bcrypt ----------------
  describe('password policy and bcrypt', () => {
    it('rejects passwords longer than 72 bytes (bcrypt would cut them)', async () => {
      // 40 Arabic letters = 40 characters but 80 bytes
      const res = await register(
        'long@test.local',
        `${'ب'.repeat(40)}1`,
      ).expect(400);
      expect(JSON.stringify(res.body.message)).toContain('72 bytes');
      await register('ascii72@test.local', `${'a'.repeat(71)}1`).expect(201);
      await register('ascii73@test.local', `${'a'.repeat(72)}1`).expect(400);
    });

    it('requires a letter and a digit', async () => {
      await register('noletter@test.local', '12345678').expect(400);
      await register('nodigit@test.local', 'abcdefgh').expect(400);
      await register('arabic@test.local', 'كلمةسر2026').expect(201);
    });

    it('stores a bcrypt hash only, and never returns it', async () => {
      const res = await register('hash@test.local').expect(201);
      expect(JSON.stringify(res.body)).not.toMatch(/\$2[aby]\$|password/i);
      const user = await db.user.findUnique({
        where: { id: res.body.user.id },
      });
      expect(user!.password).toMatch(/^\$2b\$04\$/);
      expect(user!.password).not.toContain('Password123');
    });

    it('login gives the same error for an unknown email and a wrong password', async () => {
      await register('login@test.local').expect(201);
      const a = await http()
        .post(`${API}/auth/login`)
        .send({ email: 'nobody@test.local', password: 'Password123' })
        .expect(401);
      const b = await http()
        .post(`${API}/auth/login`)
        .send({ email: 'login@test.local', password: 'Wrong1234' })
        .expect(401);
      expect(a.body.message).toBe(b.body.message);
    });

    it('cannot self-register as ADMIN or add unknown fields', async () => {
      await register('admin@test.local', 'Password123', 'ADMIN').expect(400);
      await http()
        .post(`${API}/auth/register`)
        .send({
          email: 'extra@test.local',
          password: 'Password123',
          role: 'STUDENT',
          universityId,
          isActive: true,
        })
        .expect(400);
    });
  });

  // ---------------- refresh token reuse ----------------
  it('reusing a rotated refresh token revokes every session of that user', async () => {
    const reg = await register('reuse@test.local').expect(201);
    const first = reg.body.tokens.refreshToken;
    const rotated = await http()
      .post(`${API}/auth/refresh`)
      .send({ refreshToken: first })
      .expect(200);
    const second = rotated.body.refreshToken;

    // the attacker replays the old token
    await http()
      .post(`${API}/auth/refresh`)
      .send({ refreshToken: first })
      .expect(401);
    // ... and the legitimate newer session is revoked too
    await http()
      .post(`${API}/auth/refresh`)
      .send({ refreshToken: second })
      .expect(401);
  });

  it('rejects absurdly long refresh tokens before hashing them', async () => {
    await http()
      .post(`${API}/auth/refresh`)
      .send({ refreshToken: 'a'.repeat(5000) })
      .expect(400);
  });

  // ---------------- uploads ----------------
  describe('document upload content checks', () => {
    let token = '';
    let projectId = '';
    beforeAll(async () => {
      const reg = await register('uploader@test.local').expect(201);
      token = reg.body.tokens.accessToken;
      const p = await http()
        .post(`${API}/projects`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Upload project' })
        .expect(201);
      projectId = p.body.project.id;
    });
    const upload = (name: string, body: Buffer, type: string, extra = 0) => {
      let req = http()
        .post(`${API}/documents/upload`)
        .set('Authorization', `Bearer ${token}`)
        .field('projectId', projectId)
        .field('title', 'Doc')
        .field('category', 'OTHER');
      for (let i = 0; i < extra; i++) req = req.field(`f${i}`, 'x');
      return req.attach('file', body, { filename: name, contentType: type });
    };

    it('rejects a Windows executable renamed to .pdf', async () => {
      const mz = Buffer.concat([Buffer.from('MZ\x90\x00'), Buffer.alloc(64)]);
      const res = await upload('report.pdf', mz, 'application/pdf').expect(400);
      expect(res.body.code).toBe('FILE_TYPE_NOT_ALLOWED');
    });

    it('rejects a Linux ELF binary with a harmless name', async () => {
      const elf = Buffer.concat([
        Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
        Buffer.alloc(32),
      ]);
      await upload('notes.txt', elf, 'text/plain').expect(400);
    });

    it('HTML disguised as text/plain is stored as a download, never rendered', async () => {
      const before = storage.objects.size;
      await upload(
        'notes.txt',
        Buffer.from('<!DOCTYPE html><script>alert(1)</script>'),
        'text/plain',
      ).expect(201);
      expect(storage.objects.size).toBe(before + 1);
      const last = [...storage.objects.values()].pop()!;
      expect(last.contentType).toBe('application/octet-stream');
    });

    it('limits the number of multipart fields', async () => {
      const res = await upload(
        'ok.pdf',
        Buffer.from('%PDF-1.4 ok'),
        'application/pdf',
        30,
      );
      expect([400, 413]).toContain(res.status);
      expect(JSON.stringify(res.body)).not.toMatch(/stack/i);
    });
  });

  // ---------------- health ----------------
  it('health answers 503 when the database is down, without leaking the driver message', async () => {
    const raw = db as unknown as {
      $queryRaw: (...a: unknown[]) => Promise<unknown>;
    };
    const original = raw.$queryRaw;
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    raw.$queryRaw = async () => {
      throw Object.assign(
        new Error(
          "Can't reach database server at db.secret-host.supabase.co:5432 user=postgres",
        ),
        { name: 'PrismaClientInitializationError', errorCode: 'P1001' },
      );
    };
    try {
      const res = await http().get(`${API}/health`).expect(503);
      expect(res.body).toMatchObject({
        status: 'degraded',
        database: 'disconnected',
      });
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('P1001');
      expect(logged).not.toContain('secret-host');
    } finally {
      raw.$queryRaw = original;
      warn.mockRestore();
    }
    await http().get(`${API}/health`).expect(200);
  });
});

describe('Rate limiting (P14)', () => {
  let app: INestApplication;
  let universityId = '';
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    ({ app, universityId } = await createApp({
      RATE_LIMIT_ENABLED: 'true',
      RATE_LIMIT_PER_MINUTE: '12',
      AUTH_RATE_LIMIT_PER_MINUTE: '3',
    }));
  });
  afterAll(async () => {
    await app?.close();
  });

  it('login is limited per IP with the strict limit and a clear 429', async () => {
    const attempt = () =>
      http()
        .post(`${API}/auth/login`)
        .send({ email: 'x@test.local', password: 'Wrong1234' });
    for (let i = 0; i < 3; i++) await attempt().expect(401);
    const blocked = await attempt().expect(429);
    expect(blocked.body).toMatchObject({
      statusCode: 429,
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds: expect.any(Number) },
    });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('the strict limit is counted per route (register has its own budget)', async () => {
    await http()
      .post(`${API}/auth/register`)
      .send({
        email: 'rl@test.local',
        password: 'Password123',
        role: 'STUDENT',
        universityId,
      })
      .expect(201);
  });

  it('invitation join and preview also use the strict limit', async () => {
    const reg = await http()
      .post(`${API}/auth/register`)
      .send({
        email: 'rl2@test.local',
        password: 'Password123',
        role: 'STUDENT',
        universityId,
      })
      .expect(201);
    const auth = { Authorization: `Bearer ${reg.body.tokens.accessToken}` };
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await http().get(`${API}/teams/invitations/ZZZZZZZZ`).set(auth);
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 3).every((s) => s !== 429)).toBe(true);
    expect(statuses[3]).toBe(429);
  });

  it('other routes use the global per-IP limit', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 13; i++) {
      statuses.push((await http().get(`${API}/health`)).status);
    }
    expect(statuses.slice(0, 12).every((s) => s === 200)).toBe(true);
    expect(statuses[12]).toBe(429);
  });
});

describe('Client IP behind a proxy (P15)', () => {
  let app: INestApplication;
  let db: InMemoryPrisma;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    ({ app, db } = await createApp({
      RATE_LIMIT_ENABLED: 'true',
      AUTH_RATE_LIMIT_PER_MINUTE: '2',
      CLIENT_IP_HEADER: 'true-client-ip',
    }));
  });
  afterAll(async () => {
    await app?.close();
  });

  const login = (ip?: string) => {
    const req = http()
      .post(`${API}/auth/login`)
      .send({ email: 'nobody@test.local', password: 'Wrong1234' });
    return ip ? req.set('True-Client-IP', ip) : req;
  };

  it('each real client gets its own budget (users behind one proxy are not blocked together)', async () => {
    await login('203.0.113.1').expect(401);
    await login('203.0.113.1').expect(401);
    await login('203.0.113.1').expect(429);
    // another student, same proxy connection
    await login('203.0.113.2').expect(401);
  });

  it('without the header the connection address is used', async () => {
    await login().expect(401);
    await login().expect(401);
    await login().expect(429);
  });

  it('diagnostics: ADMIN sees which IP the rate limiter uses; others are refused', async () => {
    const admin = await db.user.create({
      data: {
        email: 'diag-admin@test.local',
        password: 'unused',
        role: 'ADMIN',
      },
    });
    const student = await db.user.create({
      data: {
        email: 'diag-student@test.local',
        password: 'unused',
        role: 'STUDENT',
      },
    });
    const jwt = app.get(JwtService);
    const tokenOf = (row: unknown): string => {
      const u = row as { id: string; email: string; role: string };
      return jwt.sign({ sub: u.id, email: u.email, role: u.role });
    };

    const res = await http()
      .get(`${API}/admin/diagnostics/request`)
      .set('Authorization', `Bearer ${tokenOf(admin!)}`)
      .set('True-Client-IP', '198.51.100.9');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      rateLimitClientIp: '198.51.100.9',
      source: 'header:true-client-ip',
      clientIpHeader: 'true-client-ip',
      trueClientIp: '198.51.100.9',
    });
    expect(JSON.stringify(res.body)).not.toMatch(
      /secret|password|authorization/i,
    );

    await http()
      .get(`${API}/admin/diagnostics/request`)
      .set('Authorization', `Bearer ${tokenOf(student!)}`)
      .expect(403);
    await http().get(`${API}/admin/diagnostics/request`).expect(401);
  });
});
