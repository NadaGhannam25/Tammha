/**
 * LOCAL PRODUCTION REHEARSAL — the COMPILED build (dist/) in NODE_ENV=production,
 * without any external service:
 *
 *   npm run build
 *   SIM_ADMIN_PASSWORD=<any strong value> npm run prod:simulate      # http://localhost:3200/api/v1
 *   PROD_ADMIN_EMAIL=admin@tammha.sim PROD_ADMIN_PASSWORD=<same> \
 *     npm run prod:verify -- --base-url http://localhost:3200/api/v1 --allow-http --frontend-origin https://app.tammha.sim
 *
 * Real: compiled AppModule, production env validation, helmet/HSTS, CORS, rate limiting,
 * Swagger flag, JWT, guards, the real Gemini adapter code and LiveKit token signing.
 * Simulated: database (in-memory store), Supabase Storage (in memory), the Gemini HTTP
 * endpoint (canned valid answer; the request shape is checked), LiveKit keys (fake values).
 * Your .env is NOT read; nothing leaves this computer.
 */
import { randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import { TEST_ENV } from '../../src/testing/test-env';

const ROOT = join(__dirname, '..', '..');
// sample handbook shared with the Jest suites
const HANDBOOK_FIXTURE = join(
  ROOT,
  'src',
  'testing',
  'fixtures',
  'handbook-sample.pdf',
);
const PORT = Number(process.env.SIM_PORT || 3200);
const DIST = join(ROOT, 'dist');
if (!existsSync(join(DIST, 'app.module.js'))) {
  console.error('Build first: npm run build');
  process.exit(1);
}
const adminPassword = process.env.SIM_ADMIN_PASSWORD ?? '';
const SIM_GEMINI_KEY = `sim-${randomBytes(12).toString('hex')}`;

Object.assign(process.env, TEST_ENV, {
  NODE_ENV: 'production',
  PORT: String(PORT),
  // looks like a Supabase pooler URL; never contacted (the store is in memory)
  DATABASE_URL:
    'postgresql://postgres.simulation:not-a-password@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true',
  DIRECT_URL:
    'postgresql://postgres.simulation:not-a-password@aws-0-eu-central-1.pooler.supabase.com:5432/postgres',
  JWT_SECRET: randomBytes(32).toString('base64'),
  BCRYPT_ROUNDS: '10',
  FRONTEND_ORIGIN: process.env.SIM_FRONTEND_ORIGIN ?? 'https://app.tammha.sim',
  CORS_ORIGINS: '',
  INVITATION_LINK_BASE_URL: 'https://app.tammha.sim/join',
  PUBLIC_BASE_URL: '',
  SWAGGER_ENABLED: 'true',
  RATE_LIMIT_ENABLED: 'true',
  RATE_LIMIT_PER_MINUTE: '300',
  AUTH_RATE_LIMIT_PER_MINUTE: '10',
  CLIENT_IP_HEADER: process.env.SIM_CLIENT_IP_HEADER ?? 'true-client-ip',
  TRUST_PROXY: '',
  LIVEKIT_ENABLED: 'true',
  LIVEKIT_URL: 'wss://tammha-sim.livekit.cloud',
  LIVEKIT_API_KEY: 'APIsimulationOnly',
  LIVEKIT_API_SECRET: randomBytes(24).toString('hex'),
  AI_ENABLED: 'true',
  AI_PROVIDER: 'gemini',
  GEMINI_API_KEY: SIM_GEMINI_KEY,
  GEMINI_MODEL: 'gemini-simulated',
  EMAIL_ENABLED: 'false',
  REMINDERS_ENABLED: 'true',
});

// Simulated Gemini endpoint: checks what the real adapter sends, answers with valid guidance.
let geminiCalls = 0;
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (
    !url.startsWith('https://generativelanguage.googleapis.com/') ||
    !url.includes(':generateContent')
  ) {
    throw new Error(
      `Network access is disabled in the production simulation (attempted: ${url.split('?')[0]})`,
    );
  }
  const headers = init?.headers as Record<string, string>;
  if (
    url.includes(SIM_GEMINI_KEY) ||
    headers['x-goog-api-key'] !== SIM_GEMINI_KEY
  ) {
    throw new Error(
      'Gemini key must be sent in the x-goog-api-key header only',
    );
  }
  geminiCalls++;
  const body = JSON.parse(String(init?.body));
  const prompt: string = body.contents[0].parts[0].text;
  const ids = [...prompt.matchAll(/\[(H\d+)\] \(page/g)].map((m) => m[1]);
  const guidance = {
    summary: 'Simulated Gemini answer (production rehearsal).',
    answer: ids.length ? 'See the handbook excerpt.' : '',
    recommendations: [
      {
        title: 'Plan the next milestone',
        detail: 'Split it into tasks.',
        priority: 'HIGH',
      },
    ],
    nextSteps: ['Review the proposal feedback'],
    taskSuggestions: [],
    milestoneSuggestions: [],
    handbookReferences: ids
      .slice(0, 2)
      .map((id) => ({ excerptId: id, note: 'relevant rule' })),
    risks: [],
    confidence: 'MEDIUM',
  };
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: { parts: [{ text: JSON.stringify(guidance) }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 150 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}) as typeof fetch;

async function main() {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { Test } = require('@nestjs/testing');
  const { AppModule } = require(join(DIST, 'app.module'));
  const { configureApp, setupSwagger, getSecuritySettings } = require(
    join(DIST, 'app.setup'),
  );
  const { PrismaService } = require(join(DIST, 'prisma', 'prisma.service'));
  const { SupabaseStorageService } = require(
    join(DIST, 'modules', 'documents', 'supabase-storage.service'),
  );
  const { HandbookService } = require(
    join(DIST, 'modules', 'ai-support', 'handbook', 'handbook.service'),
  );
  const {
    createInMemoryPrisma,
  } = require('../../src/testing/in-memory-prisma');
  const { FakeStorageService } = require('../../src/testing/fake-storage');
  const bcrypt = require('bcrypt');
  /* eslint-enable @typescript-eslint/no-var-requires */
  const { readFileSync } = await import('fs');

  const db = createInMemoryPrisma();
  const university = (await db.university.create({
    data: { name: 'Almaarefa University (simulation)', code: 'UM' },
  })) as { id: string };
  if (adminPassword) {
    await db.user.create({
      data: {
        email: 'admin@tammha.sim',
        password: await bcrypt.hash(adminPassword, 10),
        role: 'ADMIN',
        firstName: 'Simulation',
      },
    });
  }

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(db)
    .overrideProvider(SupabaseStorageService)
    .useValue(new FakeStorageService())
    .compile();
  const app = moduleRef.createNestApplication({
    logger: ['error', 'warn', 'log'],
  });
  const { apiPrefix } = configureApp(app);
  const security = getSecuritySettings(app);
  if (security.swaggerEnabled) setupSwagger(app, apiPrefix);
  for (const w of security.warnings) console.warn(`WARN ${w}`);
  await app.listen(PORT, '127.0.0.1');

  // the official handbook is uploaded once by the admin in real life (npm run handbook -- upload)
  await app.get(HandbookService).upsert({
    universityId: university.id,
    title: 'Graduation Project Handbook (simulation)',
    file: {
      originalname: 'handbook.pdf',
      mimetype: 'application/pdf',
      buffer: readFileSync(HANDBOOK_FIXTURE),
      size: readFileSync(HANDBOOK_FIXTURE).length,
    },
    uploadedById: null,
  });

  console.log(
    `PRODUCTION SIMULATION (compiled build, NODE_ENV=production): http://localhost:${PORT}/${apiPrefix}`,
  );
  console.log(
    `Swagger: ${security.swaggerEnabled ? `http://localhost:${PORT}/${apiPrefix}/docs` : 'disabled'}`,
  );
  const stop = async () => {
    console.log(`Simulated Gemini calls: ${geminiCalls}`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error('Simulation failed:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
