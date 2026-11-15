/**
 * LOCAL INTEGRATION SERVER — for developing and testing the frontend against the real API
 * without any external service. NOT for production (it refuses NODE_ENV=production).
 *
 *   HARNESS_ADMIN_PASSWORD=<any strong value> npm run dev:integration
 *     API      http://localhost:3100/api/v1   (real AppModule: controllers, validation, guards, JWT,
 *                                              permissions, AI response validation, LiveKit signing)
 *     Control  http://localhost:3101           (dev-only helpers listed below)
 *   Frontend:  serve the frontend folder at http://localhost:5173 (npx http-server . -p 5173)
 *              with config.js → apiBaseUrl 'http://localhost:3100/api/v1'.
 *
 * Simulated (in memory, nothing leaves this computer):
 *   - database: the in-memory Prisma stand-in used by the integration tests;
 *   - Supabase Storage: files kept in memory and served by the control port (signed URLs);
 *   - Gemini: the fake provider used by the tests (answers built from the handbook text);
 *   - SMTP: e-mails are captured and listed on the control port (links included);
 *   - LiveKit: tokens are really signed, with throw-away keys; without a media server a browser that
 *     tries to connect gets a connection error (the frontend shows it). For real calls run a local
 *     `livekit-server --dev --bind 127.0.0.1 --keys "<key>: <secret>"` and start this server with
 *     HARNESS_LIVEKIT_URL=ws://127.0.0.1:7880 HARNESS_LIVEKIT_KEY=<key> HARNESS_LIVEKIT_SECRET=<secret>.
 * Your .env is NOT read.
 *
 * Control port (127.0.0.1 only):
 *   GET  /emails                     captured e-mails (newest last) with their links
 *   POST /ai/fail?code=AI_PROVIDER_UNAVAILABLE   next AI call fails with that code
 *   POST /ai/json   (body = JSON)    next AI call answers this JSON (e.g. {"topics":[]})
 *   POST /storage/fail?op=upload     next storage call of that kind fails
 *   GET  /storage/<path>             a stored object (what the signed URLs point to)
 */
import { randomBytes } from 'crypto';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { TEST_ENV } from '../../src/testing/test-env';

if (process.env.NODE_ENV === 'production') {
  console.error('The integration server is for local development only.');
  process.exit(1);
}

const PORT = Number(process.env.HARNESS_PORT || 3100);
const CONTROL_PORT = Number(process.env.HARNESS_CONTROL_PORT || PORT + 1);
const FRONTEND = process.env.HARNESS_FRONTEND_ORIGIN || 'http://localhost:5173';
const ADMIN_PASSWORD = process.env.HARNESS_ADMIN_PASSWORD || '';
const ROOT = join(__dirname, '..', '..');

Object.assign(process.env, TEST_ENV, {
  NODE_ENV: 'development',
  PORT: String(PORT),
  JWT_SECRET: randomBytes(32).toString('base64'),
  JWT_EXPIRATION: process.env.HARNESS_JWT_EXPIRATION || '15m',
  BCRYPT_ROUNDS: '4',
  FRONTEND_ORIGIN: FRONTEND,
  CORS_ORIGINS: FRONTEND,
  INVITATION_LINK_BASE_URL: `${FRONTEND}/join.html?code=`,
  SWAGGER_ENABLED: 'true',
  RATE_LIMIT_ENABLED: 'false',
  EMAIL_VERIFICATION_REQUIRED: 'true',
  AI_ENABLED: 'true',
  AI_PROVIDER: 'gemini',
  GEMINI_API_KEY: 'harness-not-a-key',
  GEMINI_MODEL: 'fake-gemini-model',
  LIVEKIT_ENABLED: 'true',
  LIVEKIT_URL: process.env.HARNESS_LIVEKIT_URL || 'ws://127.0.0.1:7880',
  // a local `livekit-server --dev` can be used with HARNESS_LIVEKIT_KEY / HARNESS_LIVEKIT_SECRET
  LIVEKIT_API_KEY: process.env.HARNESS_LIVEKIT_KEY || 'APIharnessOnly',
  LIVEKIT_API_SECRET:
    process.env.HARNESS_LIVEKIT_SECRET || randomBytes(24).toString('hex'),
  MEETING_JOIN_EARLY_MINUTES: '60',
  REMINDERS_ENABLED: 'false',
});

/* eslint-disable @typescript-eslint/no-var-requires */
async function main() {
  const { AppModule } = require('../../src/app.module');
  const { configureApp, setupSwagger } = require('../../src/app.setup');
  const { PrismaService } = require('../../src/prisma/prisma.service');
  const {
    SupabaseStorageService,
  } = require('../../src/modules/documents/supabase-storage.service');
  const {
    HandbookService,
  } = require('../../src/modules/ai-support/handbook/handbook.service');
  const { AI_TEXT_PROVIDER } = require('../../src/integrations/ai/ai.provider');
  const { AiProviderError } = require('../../src/integrations/ai/ai.provider');
  const { EMAIL_SENDER } = require('../../src/integrations/email/email.sender');
  const {
    createInMemoryPrisma,
  } = require('../../src/testing/in-memory-prisma');
  const { FakeStorageService } = require('../../src/testing/fake-storage');
  const { FakeAiTextProvider } = require('../../src/testing/fake-ai-provider');
  const { FakeEmailSender } = require('../../src/testing/fake-email-sender');
  const {
    HANDBOOK_UNIVERSITIES,
  } = require('../../src/modules/ai-support/library/handbook-universities');
  /* eslint-enable @typescript-eslint/no-var-requires */

  class HarnessStorage extends FakeStorageService {
    protected signed(path: string) {
      return `http://localhost:${CONTROL_PORT}/storage/${encodeURI(path)}`;
    }
  }
  const db = createInMemoryPrisma();
  const storage = new HarnessStorage();
  const ai = new FakeAiTextProvider();
  ai.delayMs = Number(process.env.HARNESS_AI_DELAY_MS || 900);
  const mail = new FakeEmailSender();

  // The four handbook universities (+ one other, never offered for handbooks).
  const domains: Record<string, string[]> = {
    almaarefa: ['um.edu.sa', 'student.um.edu.sa'],
    jouf: ['ju.edu.sa'],
    pnu: ['pnu.edu.sa'],
    tabuk: ['ut.edu.sa'],
  };
  const unis: Record<string, { id: string }> = {};
  for (const u of HANDBOOK_UNIVERSITIES) {
    unis[u.key] = await db.university.create({
      data: {
        name: u.name.en,
        code: u.code,
        emailDomains: domains[u.key] ?? [],
      },
    });
  }
  if (ADMIN_PASSWORD) {
    await db.user.create({
      data: {
        email: 'admin@harness.local',
        password: await bcrypt.hash(ADMIN_PASSWORD, 4),
        role: 'ADMIN',
        firstName: 'Harness',
        lastName: 'Admin',
        emailVerifiedAt: new Date(),
      },
    });
  }

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
  const app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
  const { apiPrefix } = configureApp(app);
  setupSwagger(app, apiPrefix);
  await app.listen(PORT, '127.0.0.1');

  // A sample PDF stands in for ONE official handbook so the "university handbook" path can be
  // exercised. It is the test fixture, not a real university document.
  if (process.env.HARNESS_SAMPLE_HANDBOOK !== 'off') {
    const pdf = readFileSync(
      join(ROOT, 'src', 'testing', 'fixtures', 'handbook-sample.pdf'),
    );
    await app.get(HandbookService).upsert({
      universityId: unis.jouf.id,
      title: 'Sample handbook (local test fixture)',
      file: {
        originalname: 'sample-handbook-fixture.pdf',
        mimetype: 'application/pdf',
        buffer: pdf,
        size: pdf.length,
      },
      uploadedById: null,
    });
  }

  const linkOf = (text: string) =>
    [...text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]);
  createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${CONTROL_PORT}`);
    const body = await new Promise<string>((resolve) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => resolve(b));
    });
    res.setHeader('Access-Control-Allow-Origin', FRONTEND);
    const json = (v: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    try {
      if (req.method === 'GET' && url.pathname === '/emails') {
        return json(
          mail.sent.map((m: { to: string; subject: string; text: string }) => ({
            to: m.to,
            subject: m.subject,
            links: linkOf(m.text),
          })),
        );
      }
      if (req.method === 'POST' && url.pathname === '/ai/fail') {
        ai.nextError(
          new AiProviderError(
            url.searchParams.get('code') || 'AI_PROVIDER_UNAVAILABLE',
          ),
        );
        return json({ ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/ai/json') {
        ai.nextJson(JSON.parse(body || '{}'));
        return json({ ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/storage/fail') {
        storage.failNext(url.searchParams.get('op') || 'upload');
        return json({ ok: true });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/storage/')) {
        const key = decodeURI(url.pathname.slice('/storage/'.length));
        const obj = storage.objects.get(key);
        if (!obj) return json({ error: 'not found' }, 404);
        res.writeHead(200, { 'content-type': obj.contentType });
        return res.end(obj.body);
      }
      return json({ error: 'unknown route' }, 404);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }).listen(CONTROL_PORT, '127.0.0.1');

  console.log(`INTEGRATION SERVER  API http://localhost:${PORT}/${apiPrefix}`);
  console.log(
    `                    Swagger http://localhost:${PORT}/${apiPrefix}/docs`,
  );
  console.log(`                    Control http://localhost:${CONTROL_PORT}`);
  console.log(`                    Frontend origin allowed: ${FRONTEND}`);
  console.log(
    ADMIN_PASSWORD
      ? '                    Admin: admin@harness.local (password from HARNESS_ADMIN_PASSWORD)'
      : '                    No admin (set HARNESS_ADMIN_PASSWORD to create one)',
  );
  const stop = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error('Integration server failed:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
