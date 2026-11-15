import { Logger } from '@nestjs/common';
import {
  LiveKitMeetingVideoProvider,
  toWebSocketUrl,
} from '@/integrations/meetings/livekit-meeting-video.provider';
import { newMeetingRoomName } from '@/integrations/meetings/meeting-video.provider';
import { verifyHs256 } from '@/testing/verify-hs256';
import { validateEnv } from '@/config/env.validation';
import { TEST_ENV } from '@/testing/test-env';
import { MEETING_DEFAULTS, readMeetingSettings } from '../meetings.config';

const SECRET = 'unit-test-only-secret-0123456789abcdefghij';
const config = {
  enabled: true as const,
  url: 'wss://unit.livekit.cloud',
  apiKey: 'APIunitKey',
  apiSecret: SECRET,
  tokenTtlSeconds: 3600,
};
const request = {
  roomName: 'tammha-room',
  identity: 'user-1',
  displayName: 'User',
  canPublish: true,
};

describe('LiveKitMeetingVideoProvider (local signing, no network)', () => {
  it('signs a room-scoped token with the configured TTL', async () => {
    const provider = new LiveKitMeetingVideoProvider(config);
    const before = Math.floor(Date.now() / 1000);
    const creds = await provider.createJoinCredentials(request);
    const claims = verifyHs256(creds.token, SECRET);
    expect(claims.exp - before).toBeGreaterThanOrEqual(3599);
    expect(claims.exp - before).toBeLessThanOrEqual(3601);
    expect(claims.video).toMatchObject({ room: 'tammha-room', roomJoin: true });
  });

  it('never issues a token shorter than 60 seconds', async () => {
    const provider = new LiveKitMeetingVideoProvider(config);
    const creds = await provider.createJoinCredentials({
      ...request,
      ttlSeconds: 5,
    });
    const claims = verifyHs256(creds.token, SECRET);
    expect(claims.exp - claims.nbf).toBeGreaterThanOrEqual(60);
  });

  it('a view-only participant cannot publish', async () => {
    const provider = new LiveKitMeetingVideoProvider(config);
    const creds = await provider.createJoinCredentials({
      ...request,
      canPublish: false,
    });
    expect(verifyHs256(creds.token, SECRET).video).toMatchObject({
      canPublish: false,
      canPublishData: false,
      canSubscribe: true,
    });
  });

  it('a signing failure becomes 503 MEETING_TOKEN_UNAVAILABLE and logs nothing secret', async () => {
    const logged: string[] = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => {
      logged.push(String(m));
    });
    // an empty secret makes the SDK refuse to sign
    const provider = new LiveKitMeetingVideoProvider({
      ...config,
      apiSecret: '',
    });
    const error = await provider.createJoinCredentials(request).catch((e) => e);
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toMatchObject({
      code: 'MEETING_TOKEN_UNAVAILABLE',
    });
    expect(logged.join(' ')).not.toContain(SECRET);
    expect(logged.join(' ')).not.toContain('APIunitKey');
    jest.restoreAllMocks();
  });

  it('URLs for the browser are WebSocket URLs', () => {
    expect(toWebSocketUrl('https://x.livekit.cloud')).toBe(
      'wss://x.livekit.cloud',
    );
    expect(toWebSocketUrl('wss://x.livekit.cloud')).toBe(
      'wss://x.livekit.cloud',
    );
    expect(toWebSocketUrl('http://localhost:7880')).toBe('ws://localhost:7880');
  });

  it('room names are random and contain no ids or titles', () => {
    const a = newMeetingRoomName();
    expect(a).toMatch(
      /^tammha-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(newMeetingRoomName()).not.toBe(a);
  });
});

describe('Meeting settings', () => {
  it('defaults and validation', () => {
    expect(readMeetingSettings({})).toEqual({
      settings: MEETING_DEFAULTS,
      errors: [],
    });
    expect(MEETING_DEFAULTS).toEqual({
      joinEarlyMinutes: 15,
      joinGraceMinutes: 30,
    });
    expect(
      readMeetingSettings({ MEETING_JOIN_EARLY_MINUTES: '500' }).errors,
    ).toEqual([
      'MEETING_JOIN_EARLY_MINUTES must be an integer between 0 and 120',
    ]);
    expect(() =>
      validateEnv({ ...TEST_ENV, MEETING_JOIN_GRACE_MINUTES: '-1' }),
    ).toThrow(/MEETING_JOIN_GRACE_MINUTES/);
  });

  it('LIVEKIT_ENABLED is false by default and then needs no LiveKit variables', () => {
    expect(TEST_ENV.LIVEKIT_ENABLED).toBe('');
    expect(() => validateEnv({ ...TEST_ENV })).not.toThrow();
    expect(() => validateEnv({ ...TEST_ENV, LIVEKIT_ENABLED: 'true' })).toThrow(
      /LIVEKIT_URL is required[\s\S]*LIVEKIT_API_KEY is required[\s\S]*LIVEKIT_API_SECRET is required/,
    );
  });
});
