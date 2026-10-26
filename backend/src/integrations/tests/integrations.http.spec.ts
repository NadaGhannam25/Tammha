import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { verifyHs256 } from '@/testing/verify-hs256';
import { PrismaService } from '@/prisma/prisma.service';
import { configureApp, createSwaggerDocument } from '@/app.setup';
import { testConfigModule, TestEnvOverrides } from '@/testing/test-env';
import { createInMemoryPrisma } from '@/testing/in-memory-prisma';
import { AuthModule } from '@modules/auth/auth.module';
import { IntegrationsModule } from '../integrations.module';
import {
  MEETING_VIDEO_PROVIDER,
  MeetingVideoProvider,
  roomNameForMeeting,
} from '../meetings/meeting-video.provider';
import { AI_TEXT_PROVIDER, AiTextProvider } from '../ai/ai.provider';
import { EMAIL_SENDER, EmailSender } from '../email/email.sender';

const SECRETS = {
  LIVEKIT_API_SECRET: 'LK-SECRET-VALUE-0001',
  LIVEKIT_API_KEY: 'LK-KEY-VALUE-0001',
  GEMINI_API_KEY: 'GEMINI-SECRET-0001',
};

async function bootApp(overrides: TestEnvOverrides = {}) {
  const db = createInMemoryPrisma();
  const moduleRef = await Test.createTestingModule({
    imports: [testConfigModule(overrides), AuthModule, IntegrationsModule],
  })
    .overrideProvider(PrismaService)
    .useValue(db)
    .compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  const user = await db.user.create({
    data: {
      email: 'student@test.local',
      password: 'unused',
      firstName: 'S',
      role: 'STUDENT',
      universityId: 'uni-1',
    },
  });
  const token = app
    .get(JwtService)
    .sign({ sub: user!.id, email: user!.email, role: 'STUDENT' });
  return { app, token };
}

describe('Integrations (P10) — disabled by default', () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    ({ app, token } = await bootApp());
  });
  afterAll(async () => app?.close());

  it('GET /integrations/status needs a JWT', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/integrations/status')
      .expect(401);
  });

  it('reports every integration as DISABLED', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/integrations/status')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toEqual({
      livekit: { enabled: false, state: 'DISABLED', provider: null },
      ai: { enabled: false, state: 'DISABLED', provider: null, model: null },
      email: { enabled: false, state: 'DISABLED', provider: null },
    });
  });

  it('ports are injectable and refuse work with 503 INTEGRATION_DISABLED', async () => {
    const video = app.get<MeetingVideoProvider>(MEETING_VIDEO_PROVIDER);
    const ai = app.get<AiTextProvider>(AI_TEXT_PROVIDER);
    const email = app.get<EmailSender>(EMAIL_SENDER);
    expect([video.name, ai.name, email.name]).toEqual([
      'disabled',
      'disabled',
      'disabled',
    ]);
    expect([video.isEnabled(), ai.isEnabled(), email.isEnabled()]).toEqual([
      false,
      false,
      false,
    ]);

    const calls = [
      video.createJoinCredentials({
        roomName: roomNameForMeeting('m1'),
        identity: 'u1',
        displayName: 'U',
        canPublish: true,
      }),
      ai.generateText({ prompt: 'hello' }),
      email.send({ to: 'a@b.test', subject: 's', text: 't' }),
    ];
    for (const call of calls) {
      await expect(call).rejects.toMatchObject({
        status: 503,
        response: expect.objectContaining({ code: 'INTEGRATION_DISABLED' }),
      });
    }
  });

  it('Swagger documents the status route', () => {
    expect(Object.keys(createSwaggerDocument(app).paths)).toContain(
      '/api/v1/integrations/status',
    );
  });
});

describe('Integrations (P10) — enabled and configured', () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    ({ app, token } = await bootApp({
      LIVEKIT_ENABLED: 'true',
      LIVEKIT_URL: 'wss://tammha-test.livekit.cloud',
      LIVEKIT_API_KEY: SECRETS.LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET: SECRETS.LIVEKIT_API_SECRET,
      AI_ENABLED: 'true',
      AI_PROVIDER: 'gemini',
      GEMINI_API_KEY: SECRETS.GEMINI_API_KEY,
      GEMINI_MODEL: 'test-gemini-model',
    }));
  });
  afterAll(async () => app?.close());

  it('status shows provider names, never URLs, keys, secrets or addresses', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/integrations/status')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toEqual({
      livekit: { enabled: true, state: 'CONFIGURED', provider: 'livekit' },
      ai: {
        enabled: true,
        state: 'CONFIGURED',
        provider: 'gemini',
        model: 'test-gemini-model',
      },
      email: { enabled: false, state: 'DISABLED', provider: null },
    });
    const text = JSON.stringify(res.body);
    for (const v of [...Object.values(SECRETS), 'livekit.cloud']) {
      expect(text).not.toContain(v);
    }
  });

  it('AI uses the Gemini adapter; LiveKit issues a local token; e-mail stays disabled', async () => {
    const ai = app.get<AiTextProvider>(AI_TEXT_PROVIDER);
    expect(ai.name).toBe('gemini');
    expect(ai.isEnabled()).toBe(true);
    // P12: LiveKit is implemented — a locally signed, room-scoped token (no network call)
    const video = app.get<MeetingVideoProvider>(MEETING_VIDEO_PROVIDER);
    expect(video.name).toBe('livekit');
    const creds = await video.createJoinCredentials({
      roomName: 'room-1',
      identity: 'user-1',
      displayName: 'User One',
      canPublish: true,
      ttlSeconds: 600,
    });
    expect(creds.serverUrl).toBe('wss://tammha-test.livekit.cloud');
    const claims = verifyHs256(creds.token, SECRETS.LIVEKIT_API_SECRET);
    expect(() => verifyHs256(creds.token, 'wrong-secret')).toThrow();
    expect(claims).toMatchObject({
      iss: SECRETS.LIVEKIT_API_KEY,
      sub: 'user-1',
      name: 'User One',
      video: { room: 'room-1', roomJoin: true, canPublish: true },
    });
    expect(claims.exp - claims.nbf).toBeLessThanOrEqual(600);
    expect(JSON.stringify(creds)).not.toContain(SECRETS.LIVEKIT_API_SECRET);
    const email = app.get<EmailSender>(EMAIL_SENDER);
    expect([email.name, email.isEnabled()]).toEqual(['disabled', false]);
  });

  it('AI errors carry no secrets (the network is blocked in tests)', async () => {
    const ai = app.get<AiTextProvider>(AI_TEXT_PROVIDER);
    const error = await ai.generateText({ prompt: 'x' }).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    const text = `${error.message} ${JSON.stringify(error)}`;
    for (const v of Object.values(SECRETS)) expect(text).not.toContain(v);
  });
});

describe('Integrations (P10) — invalid enabled configuration', () => {
  it('the app refuses to start and lists the missing variables', async () => {
    await expect(bootApp({ AI_ENABLED: 'true' })).rejects.toThrow(
      /GEMINI_API_KEY is required when AI_ENABLED=true[\s\S]*GEMINI_MODEL is required/,
    );
  });

  it('the app refuses EMAIL_ENABLED=true (no e-mail provider)', async () => {
    await expect(bootApp({ EMAIL_ENABLED: 'true' })).rejects.toThrow(
      /EMAIL_ENABLED=true is not supported/,
    );
  });
});
